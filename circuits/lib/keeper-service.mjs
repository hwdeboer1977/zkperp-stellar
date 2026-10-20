// The keeper service (step 14): liquidations (step 8), stop-loss / take-profit
// execution (steps 11-12) and limit-order fills (step 13), as a long-running
// loop with observable state. Used by services/keeper-server.mjs (HTTP API)
// and scripts/keeper.mjs (CLI).
//
// One of three keepers: liquidates positions whose equity fell below the
// maintenance margin, executes stop-loss / take-profit orders whose level the
// mark price crossed, and fills limit orders whose limit it reached. Soroban
// port of zkperp-midnight's keeper service.
//
//   node scripts/keeper.mjs --keeper 1      # and 2, 3, each in its own terminal
//
// Reads every PositionOpened / PrivateOpened event, decrypts its keeper note
// with KEEPER_VIEW_SK, and keeps the positions in .zkperp/keeper-<n>.json
// (gitignored; it holds every position's plaintext). Each tick it drops
// positions that are closed (nullifier spent), and for each one below
// maintenance at the mark price proves `liquidate_position` and submits it,
// signed by KEEPER_<n>_SECRET (a registered keeper).
//
// So that three keepers don't all pay for the same liquidation, keeper n acts
// once a position has been due for (n - 1) x KEEPER_STAGGER_MS (default 20 s);
// normally keeper 1 does it, and if it is down, keeper 2, then 3.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { decryptNote } from "./keeper.mjs";
import { nullifierOf } from "./notes.mjs";
import { Tree } from "./tree.mjs";
import { fetchLeaves } from "./tree-fetch.mjs";
import { proveLiquidation, settleLiquidation } from "./liquidate.mjs";
import { proveExecuteOrder, fires, ORDER_FIELDS } from "./orders.mjs";
import { proveExecuteLimit, filledPosition, reached, LIMIT_FIELDS } from "./limits.mjs";
import { cfg, invoke, secretOf, addressOf, ROOT } from "./stellar.mjs";


/** Starts keeper `n` (1-3). Returns its live state (see snapshot()). */
export async function startKeeper(n) {
const TICK_MS = Number(cfg("KEEPER_TICK_MS") ?? 10_000);
const STAGGER_MS = Number(cfg("KEEPER_STAGGER_MS") ?? 20_000);
const vault = cfg("VAULT_ID");
const secret = secretOf(`KEEPER_${n}`), me = addressOf(secret);
const viewSk = cfg("KEEPER_VIEW_SK");
const state = { keeper: n, account: me, vault, startedAt: new Date().toISOString(), ticks: 0, lastTick: null, lastError: null,
  mark: null, actions: [], errors: 0 };
const log = (s) => {
  console.log(`${new Date().toISOString()} [keeper ${n}] ${s}`);
  if (/^(liquidated|executed|filled)/.test(s)) state.actions = [{ at: new Date().toISOString(), what: s }, ...state.actions].slice(0, 20);
};
const ro = (fn, args) => invoke({ id: vault, secret, fn, args, send: false });
const fmt = (x) => (Number(x) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 2 });

const lc = ro("liquidation_config");
if (!lc.keepers.includes(me)) throw new Error(`KEEPER_${n} (${me}) is not a registered keeper of ${vault}`);
const dbFile = `${ROOT}.zkperp/keeper-${n}-${vault}.json`;
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, "utf8")) : { lastLedger: 0, positions: {} };
db.orders ??= {};
db.limits ??= {};
const save = () => { fs.mkdirSync(ROOT + ".zkperp", { recursive: true, mode: 0o700 }); fs.writeFileSync(dbFile, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 }); };
const due = new Map(); // leaf -> first time seen liquidatable

function latestLedger() {
  return JSON.parse(execFileSync("curl", ["-s", "https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1"]))._embedded.records[0].sequence;
}

async function sync() {
  const latest = latestLedger();
  const start = Math.max(db.lastLedger + 1, latest - 11_000); // testnet RPC keeps ~11,500 ledgers
  const seen = new Set(); // scan windows overlap: handle each event once
  for (let from = start; from <= latest; from += 5_000) {
    const out = execFileSync("stellar", ["events", "--network", "testnet", "--id", vault, "--start-ledger", String(from), "--output", "json", "--count", "1000"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) {
      if (!line.startsWith("{")) continue;
      const e = JSON.parse(line);
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const p = e.params;
      if (e.event_name === "OrderPlaced") {
        const o = await decryptNote(viewSk, [p.note_r.x, p.note_r.y], p.note, ORDER_FIELDS);
        db.orders[p.order_id] = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
        log(`new ${o.kind === 0n ? "stop loss" : "take profit"} on #${o.leafIndex} at ${fmt(o.trigger)}`);
        continue;
      }
      if (e.event_name === "OrderCancelled") { delete db.orders[p.order_id]; continue; }
      if (e.event_name === "LimitPlaced") {
        const o = await decryptNote(viewSk, [p.note_r.x, p.note_r.y], p.note, LIMIT_FIELDS);
        db.limits[p.order] = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
        log(`new limit ${o.isLong === 1n ? "long" : "short"} ${fmt(o.size)} at ${fmt(o.limitPrice)}`);
        continue;
      }
      if (e.event_name === "LimitCancelled") { delete db.limits[p.order]; continue; }
      if (e.event_name === "LimitFilled") {
        const o = db.limits[p.order];
        delete db.limits[p.order];
        if (o && !db.positions[p.leaf_index]) {
          const config = ro("perp_config");
          const pos = await filledPosition(o, p.entry_price, p.open_time, config.fee_bps);
          db.positions[p.leaf_index] = Object.fromEntries(Object.entries(pos).filter(([k]) => k !== "commitment").map(([k, v]) => [k, k === "isLong" ? (v ? "1" : "0") : v.toString()]));
          log(`new position #${p.leaf_index} (filled limit): ${pos.isLong ? "long" : "short"} ${fmt(pos.size)} @ ${fmt(pos.entryPrice)}`);
        }
        continue;
      }
      if (e.event_name !== "PositionOpened" && e.event_name !== "PrivateOpened") continue;
      if (db.positions[p.leaf_index]) continue;
      const d = await decryptNote(viewSk, [p.note_r.x, p.note_r.y], p.note);
      db.positions[p.leaf_index] = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.toString()]));
      log(`new position #${p.leaf_index}: ${d.isLong === 1n ? "long" : "short"} ${fmt(d.size)} @ ${fmt(d.entryPrice)}`);
    }
  }
  db.lastLedger = latest;
  save();
}

async function tick() {
  await sync();
  const mark = ro("mark_price"), config = ro("perp_config"), borrowRate = ro("borrow_rate");
  state.mark = { price: mark.price, round: mark.round, ageSeconds: Math.floor(Date.now() / 1000) - mark.time, maxAgeSeconds: config.max_price_age };
  const now = BigInt(Math.floor(Date.now() / 1000) - 20);
  // Limit orders: fill those whose limit the mark reached.
  for (const [id, o] of Object.entries(db.limits)) {
    if (!reached(o, mark.price)) { due.delete(`l${id}`); continue; }
    if (!due.has(`l${id}`)) { due.set(`l${id}`, Date.now()); log(`limit ${o.isLong === "1" ? "long" : "short"} at ${fmt(o.limitPrice)} reached at ${fmt(mark.price)}`); }
    if (Date.now() - due.get(`l${id}`) < (n - 1) * STAGGER_MS) continue;
    if (!ro("is_limit_open", { order: id })) { delete db.limits[id]; continue; }
    const x = await proveExecuteLimit({ o, entryPrice: mark.price, openTime: now, feeBps: config.fee_bps });
    try {
      const leaf = invoke({ id: vault, secret, fn: "execute_limit", args: { keeper: me, order: id, commitment: x.soroban.commitment, open_time: now.toString(), proof: x.soroban.proof } });
      log(`filled limit ${o.isLong === "1" ? "long" : "short"} ${fmt(o.size)} at ${fmt(mark.price)} -> position #${leaf}`);
      due.delete(`l${id}`); save(); // the LimitFilled event adds the position on the next sync
    } catch (e) {
      const out = String(e.stderr ?? e.message);
      log(`fill failed: ${(out.split("\n").find((x) => /error/i.test(x)) ?? out).slice(0, 200)}`);
    }
  }

  // Trigger orders: an order the price crossed closes the position at its owner's wish.
  for (const [id, o] of Object.entries(db.orders)) {
    const pos = db.positions[o.leafIndex];
    if (!pos) { delete db.orders[id]; continue; } // position closed
    if (!fires({ ...pos, isLong: pos.isLong === "1" }, o.kind, o.trigger, mark.price)) { due.delete(`o${id}`); continue; }
    if (!due.has(`o${id}`)) { due.set(`o${id}`, Date.now()); log(`${o.kind === "0" ? "stop loss" : "take profit"} on #${o.leafIndex} crossed at ${fmt(mark.price)}`); }
    if (Date.now() - due.get(`o${id}`) < (n - 1) * STAGGER_MS) continue;
    if (!ro("is_order_open", { order_id: id })) { delete db.orders[id]; continue; }
    const tree = await Tree.fromLeaves(fetchLeaves(vault, secret));
    const r = await proveExecuteOrder({ tree, pos: { ...pos, isLong: pos.isLong === "1" }, leafIndex: Number(o.leafIndex), kind: o.kind, trigger: o.trigger,
      orderSalt: o.orderSalt, exitPrice: mark.price, closeTime: now, feeBps: config.fee_bps, maxPayout: ro("max_payout"), treasuryOwner: ro("treasury_owner"), borrowRate });
    const x = r.soroban;
    try {
      const leaf = invoke({ id: vault, secret, fn: "execute_order", args: { keeper: me, order_id: x.orderId, root: x.root.toString(), nullifier: x.nullifier,
        payout: x.payout, fee: x.fee, pool_in: x.poolIn, pool_out: x.poolOut, close_time: now.toString(), proof: x.proof } });
      log(`executed ${o.kind === "0" ? "stop loss" : "take profit"} on #${o.leafIndex}: ${r.settlement.isProfit ? "profit" : "loss"} ${fmt(r.settlement.pnl)}, owner gets ${fmt(r.settlement.payout)} (note leaf ${leaf})`);
      delete db.orders[id]; delete db.positions[o.leafIndex]; due.delete(`o${id}`); save();
    } catch (e) {
      const out = String(e.stderr ?? e.message);
      log(`execute order on #${o.leafIndex} failed: ${(out.split("\n").find((x) => /error/i.test(x)) ?? out).slice(0, 200)}`);
    }
  }
  for (const [leaf, pos] of Object.entries(db.positions)) {
    const nullifier = (await nullifierOf(pos.salt, leaf)).toString();
    if (ro("is_spent", { nullifier })) { delete db.positions[leaf]; due.delete(leaf); save(); log(`#${leaf} is closed`); continue; }
    const s = settleLiquidation({ ...pos, isLong: pos.isLong === "1" }, mark.price, config.fee_bps, lc.maintenance_bps, lc.liquidation_fee_bps, { rate: borrowRate, time: now });
    if (!s.liquidatable) { due.delete(leaf); continue; }
    if (!due.has(leaf)) { due.set(leaf, Date.now()); log(`#${leaf} is below maintenance at ${fmt(mark.price)} (equity ${fmt(s.equity)})`); }
    if (Date.now() - due.get(leaf) < (n - 1) * STAGGER_MS) continue; // not our turn yet

    const tree = await Tree.fromLeaves(fetchLeaves(vault, secret));
    const liqTime = now;
    const r = await proveLiquidation({ tree, pos: { ...pos, isLong: pos.isLong === "1" }, leafIndex: Number(leaf), exitPrice: mark.price, liqTime,
      feeBps: config.fee_bps, treasuryOwner: ro("treasury_owner"), maintenanceBps: lc.maintenance_bps, liqFeeBps: lc.liquidation_fee_bps, borrowRate });
    const l = r.soroban;
    try {
      const payoutLeaf = invoke({ id: vault, secret, fn: "liquidate", args: { keeper: me, root: l.root.toString(), nullifier: l.nullifier,
        payout: l.payout, fee: l.fee, pool_in: l.poolIn, liq_time: liqTime.toString(), proof: l.proof } });
      log(`liquidated #${leaf}: loss ${fmt(s.poolIn)} to the pool, ${fmt(s.back)} back to the owner (note leaf ${payoutLeaf})`);
      delete db.positions[leaf]; due.delete(leaf); save();
    } catch (e) {
      const out = String(e.stderr ?? e.message);
      log(`liquidate #${leaf} failed: ${(out.split("\n").find((x) => /error/i.test(x)) ?? out).slice(0, 200)}`);
    }
  }
}

log(`watching ${vault} as ${me}`);
let stopped = false;
(async () => {
  while (!stopped) {
    try {
      await tick();
      state.ticks++;
      state.lastTick = new Date().toISOString();
    } catch (e) {
      state.errors++;
      state.lastError = { at: new Date().toISOString(), message: String(e.message).split("\n")[0].slice(0, 300) };
      log(`error: ${state.lastError.message}`);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
})();

/** A snapshot for /health: counts only, never decrypted position data. */
state.snapshot = () => ({
  ...state, snapshot: undefined,
  tracked: { positions: Object.keys(db.positions).length, orders: Object.keys(db.orders).length, limits: Object.keys(db.limits).length },
  due: due.size,
  owed: (() => { try { return ro("keeper_owed", { keeper: me }); } catch { return null; } })(),
});
state.stop = () => { stopped = true; };
return state;
}
