// Opens a long or short on the vault:
//   node scripts/open.mjs <long|short> <size mUSDC> <collateral mUSDC> [ROLE]
// ROLE names the account in .env (<ROLE>_SECRET); default TRADER.
// Proves locally, submits with the stellar CLI, and saves the private position
// record (owner secret, salt) to .zkperp/positions/ (gitignored). Lose it and
// the position can't be closed.
import fs from "node:fs";
import { proveOpen } from "../lib/open.mjs";
import { cfg, invoke, secretOf, addressOf, ROOT } from "../lib/stellar.mjs";

const [side, sizeArg, collArg, role = "TRADER"] = process.argv.slice(2);
if (!["long", "short"].includes(side) || !sizeArg || !collArg) {
  console.error("usage: node scripts/open.mjs <long|short> <size> <collateral> [ROLE]");
  process.exit(1);
}
const vault = cfg("VAULT_ID");
const decimals = BigInt(cfg("COLLATERAL_DECIMALS") ?? 7);
const units = (x) => BigInt(Math.round(Number(x) * 1e4)) * 10n ** decimals / 10_000n;
const secret = secretOf(role);
const trader = addressOf(secret);

const ro = (fn) => invoke({ id: vault, secret, fn, send: false });
const mark = ro("mark_price");
const config = ro("perp_config");
// Slightly behind wall-clock time: the ledger's clock must not be earlier.
const openTime = BigInt(Math.floor(Date.now() / 1000) - 20);

console.log(`proving ${side} size=${sizeArg} collateral=${collArg} at mark ${mark.price}...`);
const t0 = Date.now();
const r = await proveOpen({
  isLong: side === "long", size: units(sizeArg), collateral: units(collArg),
  entryPrice: BigInt(mark.price), openTime, feeBps: config.fee_bps,
  keeperPk: [config.keeper_key.x, config.keeper_key.y],
});
console.log(`proved in ${((Date.now() - t0) / 1000).toFixed(1)} s; submitting...`);

const leaf = invoke({
  id: vault, secret, fn: "open_position",
  args: {
    trader, collateral: units(collArg).toString(), open_time: openTime.toString(),
    commitment: BigInt("0x" + r.soroban.commitment).toString(),
    note_r: { x: BigInt("0x" + r.soroban.noteR[0]).toString(), y: BigInt("0x" + r.soroban.noteR[1]).toString() },
    note: r.soroban.note.map((e) => BigInt("0x" + e).toString()),
    proof: r.soroban.proof,
  },
});
const dir = ROOT + ".zkperp/positions";
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const record = { vault, leafIndex: leaf, trader, ...r.position };
fs.writeFileSync(`${dir}/${vault}-${leaf}.json`, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
console.log(`opened position #${leaf} (${side}); record saved to .zkperp/positions/${vault}-${leaf}.json`);
process.exit(0);
