// Deploys and fully initializes a new ZKPerp vault (steps 3-9), signed by
// ADMIN_SECRET:   node scripts/deploy-vault.mjs
// Uses COLLATERAL_SAC, MAX_PAYOUT, ORACLE_1..3_ADDRESS, KEEPER_VIEW_PK_X/Y,
// FEE_BPS, MAX_PRICE_AGE, TREASURY_OWNER_HASH and KEEPER_1..3_ADDRESS from
// .env, and the verification keys in circuits/keys/. Prints the vault ID.
// After a testnet reset, run it and put the ID in VAULT_ID.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { cfg, secretOf, invoke, ROOT } from "../lib/stellar.mjs";
import { rawKey } from "../lib/oracle.mjs";
import { vkeyToSoroban } from "../lib/encoding.mjs";

const admin = secretOf("ADMIN");
const vk = (n) => vkeyToSoroban(JSON.parse(fs.readFileSync(new URL(`../keys/${n}.vkey.json`, import.meta.url))));
const env = { ...process.env, STELLAR_ACCOUNT: admin };
const wasm = ROOT + "target/wasm32v1-none/release/zkperp_vault.wasm";
const id = execFileSync("stellar", ["contract", "deploy", "--wasm", wasm, "--network", "testnet", "--",
  "--admin", cfg("ADMIN_ADDRESS"), "--token", cfg("COLLATERAL_SAC"), "--max_payout", cfg("MAX_PAYOUT")],
  { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop();
console.log(`deployed ${id}`);
const call = (fn, args) => invoke({ id, secret: admin, fn, args });
call("init_perp", {
  config: { signers: [1, 2, 3].map((k) => rawKey(cfg(`ORACLE_${k}_ADDRESS`))), keeper_key: { x: cfg("KEEPER_VIEW_PK_X"), y: cfg("KEEPER_VIEW_PK_Y") },
    fee_bps: Number(cfg("FEE_BPS")), max_price_age: Number(cfg("MAX_PRICE_AGE")) },
  open_vk: vk("open_position"),
});
call("init_notes", { open_private_vk: vk("open_private"), withdraw_vk: vk("withdraw_note") });
call("init_close", { close_vk: vk("close_position"), treasury_owner: cfg("TREASURY_OWNER_HASH") });
call("init_liquidation", { liquidate_vk: vk("liquidate_position"), config: {
  keepers: [1, 2, 3].map((k) => cfg(`KEEPER_${k}_ADDRESS`)), maintenance_bps: Number(cfg("MAINTENANCE_BPS") ?? 250), liquidation_fee_bps: Number(cfg("LIQUIDATION_FEE_BPS") ?? 50) } });
call("init_limits", { place_vk: vk("place_limit"), execute_vk: vk("execute_limit"), cancel_vk: vk("cancel_limit") });
call("init_orders", { order_auth_vk: vk("order_auth"), execute_order_vk: vk("execute_order") });
call("set_borrow_rate", { rate: Number(cfg("BORROW_RATE") ?? 27778) });
call("init_treasury", { merge_vk: vk("merge_notes"), keeper_share_bps: Number(cfg("KEEPER_SHARE_BPS") ?? 3000) });
console.log(`initialized: trading, notes, closing, liquidation, orders, limit orders, borrow rate, treasury`);
console.log(id);
