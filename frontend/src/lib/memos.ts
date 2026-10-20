// Your records on chain (step 17): every private record is also posted,
// encrypted under your position key, to the memo board contract, so any
// computer with the same wallet account and password rebuilds your portfolio,
// as on Midnight (and as on Hyperliquid: log in anywhere).
//
// - Posting: after each change, the records not yet on chain are packed into
//   memos (padded to 512 or 1,024 bytes, so their size says little) and posted
//   by the relayer: your account never appears.
// - Scanning: new memos are read and trial-decrypted (AES-GCM: other people's
//   memos fail the tag check). Each record is placed by finding its commitment
//   in the vault's tree; whether it's spent, closed or filled comes from the
//   chain, not from the memo.
import { useEffect, useSyncExternalStore } from "react";
import { Buffer } from "buffer";
import { nativeToScVal } from "@stellar/stellar-sdk";
import type { Config } from "./config";
import { read, simulate } from "./chain";
import { relay } from "./relay";
import type { PositionKey } from "./positionKey";
import { getRecords, isLoadedFor, updateRecords, useRecords, type LimitRec, type NoteRec, type OrderRec, type PositionRec, type Records } from "./store";
import { sync } from "./trading";
import * as zk from "./zk";

type NoteItem = { t: "n" } & Omit<NoteRec, "leafIndex" | "spent">;
type PosItem = { t: "p" } & Omit<PositionRec, "leafIndex">;
type OrderItem = { t: "o"; pc: string } & Omit<OrderRec, "leaf">;
type LimitItem = { t: "l" } & Omit<LimitRec, "fillLeaf">;
export type Item = NoteItem | PosItem | OrderItem | LimitItem;

const MEMO = 1024, IV = 12, TAG = 16;
const BUCKETS = [512 - IV - TAG, MEMO - IV - TAG]; // plaintext sizes
const aad = (vault: string) => new TextEncoder().encode(`zkperp-memo-v1:${vault}`);

/** JSON with sorted keys, so the same record always hashes the same. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);
async function idOf(item: Item) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(item))));
  return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The records worth posting. Left out: what the chain already lets any
 * computer rebuild (payout notes of liquidations and executed orders,
 * positions filled from your limit orders: `sync` derives those), and state
 * the chain holds (spent, executed, filled).
 */
export function itemsOf(r: Records): Item[] {
  const items: Item[] = [];
  for (const { leafIndex: _l, spent: _s, ...n } of r.notes) {
    if (/^(liquidation of|order on)/.test(n.origin ?? "")) continue;
    items.push({ t: "n", ...n });
  }
  for (const { leafIndex: _l, ...p } of r.positions) {
    if (p.fromLimit && p.closed?.how !== "closed") continue;
    items.push({ t: "p", ...p, closed: p.closed?.how === "closed" ? p.closed : undefined });
  }
  for (const { leaf, ...o } of r.orders) {
    const pc = r.positions.find((p) => p.leafIndex === leaf)?.commitment;
    if (pc) items.push({ t: "o", ...o, pc, done: o.done === "cancelled" ? "cancelled" : undefined });
  }
  for (const { fillLeaf: _f, ...l } of r.limits) items.push({ t: "l", ...l, status: l.status === "cancelled" ? "cancelled" : undefined });
  return items;
}

async function seal(key: PositionKey, vault: string, items: Item[]) {
  const json = JSON.stringify({ v: 1, i: items });
  const size = BUCKETS.find((b) => json.length <= b);
  if (!size) throw new Error("memo too large");
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(vault) }, key.storageKey, new TextEncoder().encode(json.padEnd(size, " "))));
  return Buffer.concat([iv, ct]).toString("hex");
}

async function open(key: PositionKey, vault: string, memo: Uint8Array): Promise<Item[] | null> {
  if (memo.length <= IV + TAG) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: memo.slice(0, IV), additionalData: aad(vault) }, key.storageKey, memo.slice(IV));
    const m = JSON.parse(new TextDecoder().decode(pt));
    return m?.v === 1 && Array.isArray(m.i) ? m.i : null;
  } catch {
    return null; // someone else's memo
  }
}

/** Packs items into as few memos as fit. */
function pack(items: Item[]) {
  const out: Item[][] = [];
  let cur: Item[] = [];
  for (const it of items) {
    if (cur.length && JSON.stringify({ v: 1, i: [...cur, it] }).length > BUCKETS[1]) { out.push(cur); cur = []; }
    cur.push(it);
  }
  if (cur.length) out.push(cur);
  return out;
}

// ── status, for the UI ──────────────────────────────────────────────────────
export interface MemoStatus { pending: number; posting: boolean; scanned: number | null; error: string | null; restored: number }
let status: MemoStatus = { pending: 0, posting: false, scanned: null, error: null, restored: 0 };
const listeners = new Set<() => void>();
const setStatus = (s: Partial<MemoStatus>) => { status = { ...status, ...s }; listeners.forEach((l) => l()); };
export const useMemoStatus = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => status);

// ── posting ─────────────────────────────────────────────────────────────────
let flushing: Promise<void> | null = null;
let again = false;

async function unposted(r: Records) {
  const posted = new Set(r.posted ?? []);
  const out: { item: Item; id: string }[] = [];
  for (const item of itemsOf(r)) {
    const id = await idOf(item);
    if (!posted.has(id)) out.push({ item, id });
  }
  return out;
}

/** Posts every record not yet on chain (one relayer transaction per memo). */
export function flush(vault: string, key: PositionKey) {
  if (!isLoadedFor(vault, key)) return Promise.resolve();
  if (flushing) { again = true; return flushing; }
  flushing = (async () => {
    try {
      do {
        again = false;
        const todo = await unposted(getRecords());
        setStatus({ pending: todo.length });
        for (const group of pack(todo.map((t) => t.item))) {
          setStatus({ posting: true });
          await relay(vault, "post_memo", { data: await seal(key, vault, group) });
          const ids = await Promise.all(group.map(idOf));
          if (!isLoadedFor(vault, key)) return;
          await updateRecords(vault, key, (x) => { x.posted = [...new Set([...(x.posted ?? []), ...ids])]; });
          setStatus({ pending: Math.max(0, status.pending - group.length), error: null });
        }
      } while (again);
    } catch (e) {
      setStatus({ error: `Couldn't save to chain: ${(e as Error).message}` });
    } finally {
      setStatus({ posting: false });
      flushing = null;
    }
  })();
  return flushing;
}

// ── scanning ────────────────────────────────────────────────────────────────
async function boardRead(c: Config, start: number) {
  const n = Number(await simulate(c, c.MEMO_BOARD_ID!, "count", []));
  const memos: Uint8Array[] = [];
  for (let s = start; s < n; s += 50)
    memos.push(...((await simulate(c, c.MEMO_BOARD_ID!, "get", [nativeToScVal(s, { type: "u32" }), nativeToScVal(50, { type: "u32" })])) as Uint8Array[]));
  return { n, memos };
}

/** Reads new memos, adds what's yours to your records, then syncs with the chain. */
export async function scan(c: Config, vault: string, key: PositionKey) {
  if (!isLoadedFor(vault, key)) return 0;
  const start = getRecords().memoNext ?? 0;
  const { n, memos } = await boardRead(c, start);
  const items: Item[] = [];
  for (const m of memos) items.push(...((await open(key, vault, m)) ?? []));
  let added = 0;
  if (items.length) {
    // Place records by their commitment in the tree.
    const count = Number(await read<number>(c, vault, "position_count"));
    const leaves = new Map<string, number>();
    for (let s = 0; s < count; s += 100)
      (await read<bigint[]>(c, vault, "leaves", { start: s, count: Math.min(100, count - s) })).forEach((l, i) => leaves.set(BigInt(l).toString(), s + i));
    const ids = await Promise.all(items.map(idOf));
    if (!isLoadedFor(vault, key)) return 0;
    await updateRecords(vault, key, (x) => {
      for (const it of items) {
        if (it.t === "n") {
          const leaf = leaves.get(it.commitment);
          if (leaf === undefined || x.notes.some((q) => q.commitment === it.commitment)) continue;
          const { t: _t, ...n } = it;
          x.notes.push({ ...n, leafIndex: leaf }); added++;
        } else if (it.t === "p") {
          const leaf = leaves.get(it.commitment);
          if (leaf === undefined) continue;
          const have = x.positions.find((q) => q.commitment === it.commitment);
          const { t: _t, ...p } = it;
          if (!have) { x.positions.push({ ...p, leafIndex: leaf }); added++; }
          else if (p.closed && (!have.closed || have.closed.exitPrice === "")) have.closed = p.closed;
        } else if (it.t === "o") {
          const pos = x.positions.find((q) => q.commitment === it.pc);
          if (!pos) continue;
          const have = x.orders.find((q) => q.orderId === it.orderId);
          const { t: _t, pc: _pc, ...o } = it;
          if (!have) { x.orders.push({ ...o, leaf: pos.leafIndex }); added++; }
          else if (o.done && !have.done) have.done = o.done;
        } else if (it.t === "l") {
          const have = x.limits.find((q) => q.order === it.order);
          const { t: _t, ...l } = it;
          if (!have) { x.limits.push(l); added++; }
          else if (l.status && !have.status) have.status = l.status;
        }
      }
      x.posted = [...new Set([...(x.posted ?? []), ...ids])];
    });
  }
  // Spent elsewhere? (Only worth checking when something new arrived, or on the first scan.)
  if (items.length || start === 0) await refreshSpent(c, vault, key, getRecords());
  if (!isLoadedFor(vault, key)) return added;
  await updateRecords(vault, key, (x) => { x.memoNext = n; });
  await sync(c, vault, key, getRecords());
  setStatus({ scanned: Date.now(), restored: status.restored + added });
  return added;
}

/** Marks notes another computer spent; closes positions another computer closed. */
async function refreshSpent(c: Config, vault: string, key: PositionKey, r: Records) {
  const spent: number[] = [];
  for (const n of r.notes.filter((n) => !n.spent))
    if (await read<boolean>(c, vault, "is_spent", { nullifier: await zk.nullifierOf(BigInt(n.salt), n.leafIndex) })) spent.push(n.leafIndex);
  if (spent.length) await updateRecords(vault, key, (x) => x.notes.forEach((n) => { if (spent.includes(n.leafIndex) && !n.spent) n.spent = "spent"; }));
}

/** Keeps your records on chain and picks up what other computers did. */
export function useMemoSync(c: Config | null, vault: string | null, key: PositionKey | null, ready: boolean) {
  const records = useRecords();
  const on = !!(c?.MEMO_BOARD_ID && vault && key && ready);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const run = () => scan(c!, vault!, key!).catch((e) => live && setStatus({ error: `Couldn't read your records from chain: ${(e as Error).message}` }));
    run();
    const t = setInterval(run, 20000);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, vault, key]);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => flush(vault!, key!), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, vault, key, records]);
}
