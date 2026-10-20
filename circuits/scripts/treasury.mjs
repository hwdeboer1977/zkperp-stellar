// The treasury: finds its fee notes, merges them, and collects them into fee
// distribution (keepers' share + LP revenue).
//   node scripts/treasury.mjs              # scan and report
//   node scripts/treasury.mjs --collect    # merge all unspent fee notes into one, then collect it
//
// Fee notes are owned by TREASURY_OWNER_HASH with salt Poseidon(position salt, 1).
// The treasury runs with the keeper view key (KEEPER_VIEW_SK): it decrypts
// every position, so for each close or liquidation it can recompute the fee
// amount from the public exit price and check it against the fee note's
// commitment. State in .zkperp/treasury-<vault>.json (gitignored).
import fs from "node:fs";
import { crypto, decryptNote } from "../lib/keeper.mjs";
import { nullifierOf, noteInner, noteCommitment, recipientField } from "../lib/notes.mjs";
import { settle } from "../lib/close.mjs";
import { settleLiquidation } from "../lib/liquidate.mjs";
import { Tree } from "../lib/tree.mjs";
import { fetchLeaves } from "../lib/tree-fetch.mjs";
import { proveMerge, proveWithdraw } from "../lib/private.mjs";
import { vaultEvents } from "../lib/events.mjs";
import { cfg, invoke, secretOf, ROOT } from "../lib/stellar.mjs";

const vault = cfg("VAULT_ID");
const relayer = secretOf("RELAYER");
const treasurySecret = BigInt(cfg("TREASURY_OWNER_SECRET"));
const treasuryHash = BigInt(cfg("TREASURY_OWNER_HASH"));
const viewSk = cfg("KEEPER_VIEW_SK");
const ro = (fn, args) => invoke({ id: vault, secret: relayer, fn, args, send: false });
const fmt = (x) => (Number(x) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 7 });
const log = (s) => console.log(`[treasury] ${s}`);

const dbFile = `${ROOT}.zkperp/treasury-${vault}.json`;
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, "utf8")) : { lastLedger: 0, positions: {}, notes: {} };
const save = () => fs.writeFileSync(dbFile, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 });

const { poseidon, F } = await crypto();
const config = ro("perp_config"), maxPayout = ro("max_payout");
let lc = null;
try { lc = ro("liquidation_config"); } catch {}

const { latest, events } = vaultEvents(vault, db.lastLedger + 1);
for (const e of events) {
  const p = e.params;
  if (e.event_name === "PositionOpened" || e.event_name === "PrivateOpened") {
    const d = await decryptNote(viewSk, [p.note_r.x, p.note_r.y], p.note);
    const n = (await nullifierOf(d.salt, p.leaf_index)).toString();
    db.positions[n] = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.toString()]));
  } else if (e.event_name === "PositionClosed" || e.event_name === "PositionLiquidated") {
    const pos = db.positions[p.nullifier];
    if (!pos) { log(`fee note at leaf ${p.fee_leaf}: position unknown (opened before the event window)`); continue; }
    const P = { ...pos, isLong: pos.isLong === "1" };
    // Events before step 10 have no time/borrow_rate: no borrow fee then.
    const borrow = { rate: p.borrow_rate ?? 0, time: p.time };
    const fees = e.event_name === "PositionClosed"
      ? settle(P, p.exit_price, config.fee_bps, maxPayout, borrow).fees
      : settleLiquidation(P, p.exit_price, config.fee_bps, lc.maintenance_bps, lc.liquidation_fee_bps, borrow).fees;
    const salt = F.toObject(poseidon([BigInt(pos.salt), 1n]));
    const c = await noteCommitment(fees, await noteInner(treasuryHash, salt));
    if (c.toString() !== p.fee_commitment) { log(`fee note at leaf ${p.fee_leaf}: commitment mismatch, skipped`); continue; }
    db.notes[p.fee_leaf] ??= { leafIndex: p.fee_leaf, amount: fees.toString(), salt: salt.toString() };
  }
}
db.lastLedger = latest;

// Which of our notes are still unspent (on chain).
for (const n of Object.values(db.notes)) n.spent = ro("is_spent", { nullifier: (await nullifierOf(n.salt, n.leafIndex)).toString() });
save();
const open = Object.values(db.notes).filter((n) => !n.spent);
log(`unspent fee notes: ${open.map((n) => `leaf ${n.leafIndex} (${fmt(n.amount)})`).join(", ") || "none"}; total ${fmt(open.reduce((a, n) => a + BigInt(n.amount), 0n))}`);
log(`owed to keepers: ${fmt(ro("keeper_owed_total"))}; keeper share ${(() => { try { return ro("keeper_share_bps") / 100 + "%"; } catch { return "n/a"; } })()}`);

if (process.argv.includes("--collect") && open.length) {
  let notes = open;
  while (notes.length > 1) {
    const [a, b, ...rest] = notes;
    const tree = await Tree.fromLeaves(fetchLeaves(vault, relayer));
    const m = await proveMerge({ tree, a, b, ownerSecret: treasurySecret });
    const leaf = invoke({ id: vault, secret: relayer, fn: "merge_notes", args: { root: tree.root.toString(), nullifier_a: m.soroban.nullifierA,
      nullifier_b: m.soroban.nullifierB, merged: m.soroban.merged, proof: m.soroban.proof } });
    a.spent = b.spent = true;
    const merged = { ...m.merged, leafIndex: leaf };
    db.notes[leaf] = merged; save();
    log(`merged leaf ${a.leafIndex} + leaf ${b.leafIndex} -> leaf ${leaf} (${fmt(merged.amount)})`);
    notes = [merged, ...rest];
  }
  const note = notes[0];
  const tree = await Tree.fromLeaves(fetchLeaves(vault, relayer));
  const w = await proveWithdraw({ tree, note, ownerSecret: treasurySecret, amount: BigInt(note.amount), recipient: recipientField(vault) });
  const changeLeaf = invoke({ id: vault, secret: relayer, fn: "collect_fees", args: { root: tree.root.toString(), nullifier: w.soroban.nullifier,
    amount: note.amount, change: w.soroban.change, proof: w.soroban.proof } });
  db.notes[note.leafIndex].spent = true; save();
  log(`collected ${fmt(note.amount)} from leaf ${note.leafIndex} (change note leaf ${changeLeaf}); owed to keepers now ${fmt(ro("keeper_owed_total"))}`);
}
process.exit(0);
