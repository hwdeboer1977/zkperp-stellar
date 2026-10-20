// Stop loss / take profit on your position (steps 11-12), via the relayer:
//   node scripts/order.mjs place <position leaf> <sl|tp> <price> [ROLE]
//   node scripts/order.mjs cancel <order id> [ROLE]
//   node scripts/order.mjs list
// A keeper closes the position once the mark price crosses the level (stop
// loss: long at/below, short at/above; take profit: the reverse). The public
// sees an order id only: not the position, the kind, or the level.
// Order records (with the order salt) are kept in .zkperp/orders/ (gitignored).
import fs from "node:fs";
import { proveOrderAuth, orderIdOf, KIND, newOrderSalt } from "../lib/orders.mjs";
import { ownerSecretFor } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { fetchLeaves } from "../lib/tree-fetch.mjs";
import { relay } from "../lib/relay.mjs";
import { cfg, invoke, secretOf, ROOT } from "../lib/stellar.mjs";

const [cmd, ...args] = process.argv.slice(2);
const vault = cfg("VAULT_ID");
const reader = secretOf("RELAYER");
const ro = (fn, a) => invoke({ id: vault, secret: reader, fn, args: a, send: false });
const dir = ROOT + ".zkperp/orders";
const units = (x) => BigInt(Math.round(Number(x) * 1e4)) * 1000n;
const fmt = (x) => (Number(x) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 2 });

async function auth(rec, action, role) {
  const pos = JSON.parse(fs.readFileSync(`${ROOT}.zkperp/positions/${vault}-${rec.leaf}.json`, "utf8"));
  const ownerSecret = /^\d+$/.test(String(pos.ownerSecret)) ? BigInt(pos.ownerSecret) : ownerSecretFor(secretOf(role));
  const tree = await Tree.fromLeaves(fetchLeaves(vault, reader));
  const config = ro("perp_config");
  const r = await proveOrderAuth({ tree, pos, leafIndex: rec.leaf, ownerSecret, kind: rec.kind, trigger: rec.trigger, orderSalt: rec.orderSalt,
    action, keeperPk: [config.keeper_key.x, config.keeper_key.y] });
  const s = r.soroban;
  await relay(vault, action === 1 ? "place_order" : "cancel_order", { root: s.root.toString(), order_id: s.orderId, note_r: s.noteR, note: s.note, proof: s.proof });
  return s.orderId;
}

if (cmd === "place") {
  const [leafArg, kindArg, priceArg, role = "TRADER"] = args;
  if (!(kindArg in KIND) || !priceArg) { console.error("usage: order.mjs place <leaf> <sl|tp> <price> [ROLE]"); process.exit(1); }
  const rec = { vault, leaf: Number(leafArg), kind: KIND[kindArg].toString(), trigger: units(priceArg).toString(), orderSalt: newOrderSalt().toString(), role };
  const pos = JSON.parse(fs.readFileSync(`${ROOT}.zkperp/positions/${vault}-${rec.leaf}.json`, "utf8"));
  rec.orderId = (await orderIdOf(pos.salt, rec.kind, rec.trigger, rec.orderSalt)).toString();
  await auth(rec, 1, role);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${dir}/${vault}-${rec.orderId}.json`, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  console.log(`placed ${kindArg === "sl" ? "stop loss" : "take profit"} at ${priceArg} on #${rec.leaf}; order ${rec.orderId.slice(0, 12)}…`);
} else if (cmd === "cancel") {
  const [prefix, role = "TRADER"] = args;
  const f = fs.readdirSync(dir).find((x) => x.startsWith(`${vault}-${prefix}`));
  if (!f) { console.error("no such order"); process.exit(1); }
  const rec = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
  await auth(rec, 2, role);
  fs.rmSync(`${dir}/${f}`);
  console.log(`cancelled order ${rec.orderId.slice(0, 12)}…`);
} else if (cmd === "list") {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith(vault + "-")) : []) {
    const rec = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
    const open = ro("is_order_open", { order_id: rec.orderId });
    console.log(`${rec.orderId.slice(0, 12)}…  #${rec.leaf} ${rec.kind === "0" ? "stop loss " : "take profit"} at ${fmt(rec.trigger)}  ${open ? "open" : "done/cancelled"}`);
  }
} else {
  console.error("usage: order.mjs place|cancel|list ...");
  process.exit(1);
}
process.exit(0);
