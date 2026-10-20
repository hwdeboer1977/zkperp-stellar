// Your private records (notes, positions, orders, limit orders) per vault,
// encrypted with the position key's storage key and kept in this browser.
// "Download backup" saves the same ciphertext; "Import" restores it.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PositionKey } from "./positionKey";

export interface NoteRec { leafIndex: number; amount: string; salt: string; inner?: string; commitment: string; spent?: string; origin?: string }
export interface PositionRec {
  leafIndex: number; isLong: boolean; size: string; collateral: string; entryPrice: string; openTime: string; openFee: string; salt: string;
  commitment: string; fromLimit?: string; openedAt: string;
  closed?: { how: "closed" | "liquidated" | "stop loss" | "take profit"; exitPrice: string; payout: string; pnl?: string; at: string };
}
export interface OrderRec { orderId: string; leaf: number; kind: "0" | "1"; trigger: string; orderSalt: string; done?: string }
export interface LimitRec { order: string; isLong: boolean; size: string; collateral: string; limitPrice: string; ownerHash: string; orderSalt: string; placedAt: string; status?: string; fillLeaf?: number }
export interface Records {
  notes: NoteRec[]; positions: PositionRec[]; orders: OrderRec[]; limits: LimitRec[];
  /** Ids of the records already on the memo board (step 17), and how far it has been scanned. */
  posted?: string[]; memoNext?: number;
}

const empty = (): Records => ({ notes: [], positions: [], orders: [], limits: [] });
let records: Records = empty();
let loadedFor = "";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const getRecords = () => records;
/** True once the records in memory are the ones for this vault and key. */
export const isLoadedFor = (vault: string, key: PositionKey) => loadedFor === storageId(vault, key);
export const useRecords = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => records);

const storageId = (vault: string, key: PositionKey) => `zkperp.records.v1.${vault}.${key.id}`;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encrypt(key: PositionKey, data: Records) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key.storageKey, new TextEncoder().encode(JSON.stringify(data))));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}
async function decrypt(key: PositionKey, blob: string): Promise<Records> {
  const { iv, ct } = JSON.parse(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key.storageKey, unb64(ct));
  return { ...empty(), ...JSON.parse(new TextDecoder().decode(pt)) };
}

export async function loadRecords(vault: string, key: PositionKey | null) {
  if (!key) { records = empty(); loadedFor = ""; emit(); return; }
  const id = storageId(vault, key);
  if (loadedFor === id) return;
  let blob: string | null = null;
  try { blob = localStorage.getItem(id); } catch {}
  records = blob ? await decrypt(key, blob).catch(() => empty()) : empty();
  loadedFor = id;
  emit();
}

export async function updateRecords(vault: string, key: PositionKey, change: (r: Records) => void) {
  const next: Records = JSON.parse(JSON.stringify(records));
  change(next);
  records = next;
  emit();
  try { localStorage.setItem(storageId(vault, key), await encrypt(key, next)); } catch {}
}

export async function backupBlob(key: PositionKey) { return encrypt(key, records); }
export async function importBackup(vault: string, key: PositionKey, blob: string) {
  const r = await decrypt(key, blob); // throws if it was made with another key
  await updateRecords(vault, key, (x) => Object.assign(x, r));
}

/** Loads the records whenever the key or vault changes. */
export function useRecordsFor(vault: string | null, key: PositionKey | null) {
  const [ready, setReady] = useState(false);
  useEffect(() => { if (vault) loadRecords(vault, key).then(() => setReady(true)); }, [vault, key]);
  return ready;
}
