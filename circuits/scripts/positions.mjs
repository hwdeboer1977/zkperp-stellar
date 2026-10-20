// Lists this machine's position records on the vault with their status and
// PnL at the current mark price:  node scripts/positions.mjs
// Also detects positions a keeper liquidated: records the result and saves
// the owner's payout note (its salt is derived from the position's salt).
import fs from "node:fs";
import { settle } from "../lib/close.mjs";
import { settleLiquidation, liquidationPayoutNote } from "../lib/liquidate.mjs";
import { orderPayoutNote } from "../lib/orders.mjs";
import { filledPosition } from "../lib/limits.mjs";
import { nullifierOf, ownerSecretFor, ownerHashOf } from "../lib/notes.mjs";
import { saveNote } from "../lib/wallet.mjs";
import { cfg, invoke, secretOf, addressOf, ROOT } from "../lib/stellar.mjs";

const vault = cfg("VAULT_ID");
const reader = secretOf("RELAYER");
const ro = (fn, args) => invoke({ id: vault, secret: reader, fn, args, send: false });
const mark = ro("mark_price"), config = ro("perp_config"), maxPayout = BigInt(ro("max_payout"));
const borrow = { rate: (() => { try { return ro("borrow_rate"); } catch { return 0; } })(), time: BigInt(Math.floor(Date.now() / 1000)) };
let lc = null;
try { lc = ro("liquidation_config"); } catch {}
const fmt = (x) => (Number(x) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 2 });

// The owner secret of a record: stored (step 4) or derived from the role whose address owns it (step 6).
const roles = ["TRADER", "LP_1", "LP_2", "LP_3", "ADMIN"];
function ownerSecretOf(p) {
  if (/^\d+$/.test(String(p.ownerSecret))) return BigInt(p.ownerSecret);
  for (const r of roles) {
    const sec = cfg(`${r}_SECRET`);
    if (sec && addressOf(sec) === (p.owner ?? p.trader)) return ownerSecretFor(sec);
  }
  return null;
}

const dir = ROOT + ".zkperp/positions";

// Filled limit orders become position records.
const ldir = ROOT + ".zkperp/limits";
for (const f of fs.existsSync(ldir) ? fs.readdirSync(ldir).filter((x) => x.startsWith(vault + "-")) : []) {
  const o = JSON.parse(fs.readFileSync(`${ldir}/${f}`, "utf8"));
  if (o.cancelled || o.filled) continue;
  const fill = ro("limit_fill", { order: o.order });
  if (!fill) continue;
  const pos = await filledPosition(o, fill.entry_price, fill.open_time, config.fee_bps);
  const rec = { vault, leafIndex: fill.leaf_index, owner: o.owner, isLong: pos.isLong, size: pos.size.toString(), collateral: pos.collateral.toString(),
    entryPrice: pos.entryPrice.toString(), openTime: pos.openTime.toString(), openFee: pos.openFee.toString(), salt: pos.salt.toString(),
    commitment: pos.commitment.toString(), private: true, fromLimit: o.order, ownerSecret: `derived from ${o.role}_SECRET` };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${dir}/${vault}-${fill.leaf_index}.json`, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(`${ldir}/${f}`, JSON.stringify({ ...o, filled: fill }, null, 2) + "\n", { mode: 0o600 });
}
for (const f of fs.readdirSync(dir).filter((f) => f.startsWith(vault + "-")).sort((a, b) => parseInt(a.split("-")[1]) - parseInt(b.split("-")[1]))) {
  const file = `${dir}/${f}`;
  let p = JSON.parse(fs.readFileSync(file, "utf8"));
  const kind = p.private ? "private" : "public ";
  const head = `#${p.leafIndex} ${kind} ${p.isLong ? "LONG " : "SHORT"} size ${fmt(p.size)} @ ${fmt(p.entryPrice)}`;
  if (!p.closed && ro("is_spent", { nullifier: (await nullifierOf(p.salt, p.leafIndex)).toString() })) {
    const nullifier = (await nullifierOf(p.salt, p.leafIndex)).toString();
    const rec = ro("liquidation", { nullifier });
    const ownerSecret = ownerSecretOf(p);
    let ex = null;
    try { ex = ro("order_execution", { nullifier }); } catch {}
    if (ex && ownerSecret !== null) {
      const s = settle(p, ex.exit_price, config.fee_bps, maxPayout, { rate: ex.borrow_rate, time: ex.time });
      const note = await orderPayoutNote({ ...p, ownerHash: await ownerHashOf(ownerSecret) }, s.payout);
      saveNote(vault, { ...note, leafIndex: ex.payout_leaf, owner: p.owner ?? p.trader });
      p = { ...p, closed: { exitPrice: ex.exit_price, payout: s.payout.toString(), payoutLeaf: ex.payout_leaf, byOrder: true } };
      fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
    }
    if (!p.closed && rec && lc && ownerSecret !== null) {
      const s = settleLiquidation(p, rec.exit_price, config.fee_bps, lc.maintenance_bps, lc.liquidation_fee_bps, { rate: borrow.rate, time: rec.time });
      const note = await liquidationPayoutNote({ ...p, ownerHash: await ownerHashOf(ownerSecret) }, s.back);
      saveNote(vault, { ...note, leafIndex: rec.payout_leaf, owner: p.owner ?? p.trader });
      p = { ...p, closed: { exitPrice: rec.exit_price, payout: s.back.toString(), payoutLeaf: rec.payout_leaf, liquidated: true } };
      fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
    }
  }
  if (p.closed) {
    console.log(`${head}  ${p.closed.liquidated ? "LIQUIDATED" : p.closed.byOrder ? "closed by ORDER" : "closed"} at ${fmt(p.closed.exitPrice)}, payout ${fmt(p.closed.payout)}`);
    continue;
  }
  const s = settle(p, mark.price, config.fee_bps, maxPayout, borrow);
  let warn = "";
  if (lc) {
    const l = settleLiquidation(p, mark.price, config.fee_bps, lc.maintenance_bps, lc.liquidation_fee_bps, borrow);
    if (l.liquidatable) warn = "  BELOW MAINTENANCE";
  }
  console.log(`${head}  open; at ${fmt(mark.price)}: ${s.isProfit ? "+" : "-"}${fmt(s.pnl)}, borrow fee so far ${fmt(s.borrowFee)}, would pay out ${fmt(s.payout)}${warn}`);
}
process.exit(0);
