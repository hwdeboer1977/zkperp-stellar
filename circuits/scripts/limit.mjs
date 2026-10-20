// Limit orders (step 13), via the relayer:
//   node scripts/limit.mjs place <long|short> <size> <collateral> <limit price> [ROLE]
//   node scripts/limit.mjs cancel <order prefix> [ROLE]
//   node scripts/limit.mjs list
// A long fills once the mark is at or below the limit, a short at or above;
// a keeper opens the position at the mark price. Collateral comes from your
// smallest note that covers it. Nothing about the order is public.
// Records (with the order salt) in .zkperp/limits/ (gitignored).
import fs from "node:fs";
import { provePlaceLimit, proveCancelLimit } from "../lib/limits.mjs";
import { ownerSecretFor } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { fetchLeaves } from "../lib/tree-fetch.mjs";
import { notesOf, saveNote, markSpent } from "../lib/wallet.mjs";
import { relay } from "../lib/relay.mjs";
import { cfg, invoke, secretOf, addressOf, ROOT } from "../lib/stellar.mjs";

const [cmd, ...args] = process.argv.slice(2);
const vault = cfg("VAULT_ID");
const reader = secretOf("RELAYER");
const ro = (fn, a) => invoke({ id: vault, secret: reader, fn, args: a, send: false });
const dir = ROOT + ".zkperp/limits";
const units = (x) => BigInt(Math.round(Number(x) * 1e4)) * 1000n;
const fmt = (x) => (Number(x) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 2 });

if (cmd === "place") {
  const [side, sizeArg, collArg, limitArg, role = "TRADER"] = args;
  if (!["long", "short"].includes(side) || !limitArg) { console.error("usage: limit.mjs place <long|short> <size> <collateral> <limit> [ROLE]"); process.exit(1); }
  const secret = secretOf(role), owner = addressOf(secret), ownerSecret = ownerSecretFor(secret);
  const collateral = units(collArg);
  const note = notesOf(vault, owner).find((n) => BigInt(n.amount) >= collateral);
  if (!note) { console.error(`no unspent note of ${role} covers ${collArg}`); process.exit(1); }
  const tree = await Tree.fromLeaves(fetchLeaves(vault, reader));
  const config = ro("perp_config");
  const r = await provePlaceLimit({ tree, note, ownerSecret, isLong: side === "long", size: units(sizeArg), collateral, limitPrice: units(limitArg),
    keeperPk: [config.keeper_key.x, config.keeper_key.y] });
  const s = r.soroban;
  const changeLeaf = await relay(vault, "place_limit", { root: s.root.toString(), nullifier: s.nullifier, order: s.order, change: s.change,
    note_r: s.noteR, note: s.note, proof: s.proof });
  markSpent(vault, note.leafIndex, `limit ${s.order.slice(0, 10)}`);
  saveNote(vault, { ...r.change, leafIndex: changeLeaf, owner });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${dir}/${vault}-${s.order}.json`, JSON.stringify({ vault, owner, role, ...r.order }, null, 2) + "\n", { mode: 0o600 });
  console.log(`placed limit ${side} ${sizeArg} / ${collArg} at ${limitArg}; order ${s.order.slice(0, 12)}…; change note at leaf ${changeLeaf}`);
} else if (cmd === "cancel") {
  const [prefix, role = "TRADER"] = args;
  const f = fs.readdirSync(dir).find((x) => x.startsWith(`${vault}-${prefix}`));
  if (!f) { console.error("no such order"); process.exit(1); }
  const o = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
  const c = await proveCancelLimit({ o, ownerSecret: ownerSecretFor(secretOf(role)) });
  const leaf = await relay(vault, "cancel_limit", { order: c.soroban.order, refund: c.soroban.refund, proof: c.soroban.proof });
  saveNote(vault, { ...c.refund, leafIndex: leaf, owner: o.owner });
  fs.writeFileSync(`${dir}/${f}`, JSON.stringify({ ...o, cancelled: true }, null, 2) + "\n", { mode: 0o600 });
  console.log(`cancelled limit order ${o.order.slice(0, 12)}…; refund note ${fmt(o.collateral)} at leaf ${leaf}`);
} else if (cmd === "list") {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith(vault + "-")) : []) {
    const o = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
    const fill = ro("limit_fill", { order: o.order });
    const status = o.cancelled ? "cancelled" : fill ? `FILLED at ${fmt(fill.entry_price)} -> position #${fill.leaf_index}` : ro("is_limit_open", { order: o.order }) ? "open" : "gone";
    console.log(`${o.order.slice(0, 12)}…  ${o.isLong ? "long " : "short"} ${fmt(o.size)} / ${fmt(o.collateral)} at ${fmt(o.limitPrice)}  ${status}`);
  }
} else {
  console.error("usage: limit.mjs place|cancel|list ...");
  process.exit(1);
}
process.exit(0);
