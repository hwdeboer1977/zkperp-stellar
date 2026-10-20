// Writes a real open_position proof as a test fixture for the vault's Rust
// tests: node scripts/fixture.mjs ../contracts/zkperp-vault/src/fixtures/open.json
import fs from "node:fs";
import { newKeeperKey } from "../lib/keeper.mjs";
import { proveOpen } from "../lib/open.mjs";
import { vkeyToSoroban, hex32 } from "../lib/encoding.mjs";
import { buildPoseidon } from "circomlibjs";

const UNIT = 10_000_000n;
const keeper = await newKeeperKey();
const params = { isLong: true, size: 5_000n * UNIT, collateral: 500n * UNIT, entryPrice: 60_000n * UNIT,
  openTime: 1_760_000_000n, feeBps: 10, keeperPk: keeper.pk };
const r = await proveOpen(params);

// Root of a depth-20 tree holding just this commitment at index 0.
const poseidon = await buildPoseidon();
const F = poseidon.F;
let zero = 0n, node = BigInt(r.position.commitment);
for (let i = 0; i < 20; i++) {
  node = F.toObject(poseidon([node, zero]));
  zero = F.toObject(poseidon([zero, zero]));
}
const vk = JSON.parse(fs.readFileSync(new URL("../keys/open_position.vkey.json", import.meta.url)));
fs.writeFileSync(process.argv[2], JSON.stringify({
  keeper_pk: keeper.pk.map(hex32), keeper_sk: keeper.sk,
  vk: vkeyToSoroban(vk),
  collateral: params.collateral.toString(), price: params.entryPrice.toString(),
  open_time: params.openTime.toString(), fee_bps: params.feeBps,
  ...r.soroban, root_after: hex32(node),
}, null, 2) + "\n");
console.log("fixture written; commitment", r.position.commitment);
process.exit(0);
