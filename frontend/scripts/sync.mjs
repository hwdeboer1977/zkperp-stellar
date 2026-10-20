// Prepares public/ for the browser:
//  - public/config.json: PUBLIC settings from ../.env (an explicit allow-list;
//    no *_SECRET ever leaves the machine);
//  - public/zk/: the .wasm / .zkey files the browser proves with.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const env = {};
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*(#.*)?$/);
  if (m) env[m[1]] = m[2];
}
const PUBLIC = ["STELLAR_NETWORK", "STELLAR_NETWORK_PASSPHRASE", "HORIZON_URL", "MUSDC_CODE", "MUSDC_ISSUER", "MUSDC_SAC",
  "MUSDC_FAUCET_ID", "COLLATERAL_SAC", "COLLATERAL_DECIMALS", "VAULT_ID", "LIQ_DEMO_VAULT_ID", "RELAYER_ADDRESS", "MAX_PAYOUT", "MEMO_BOARD_ID"];
const config = Object.fromEntries(PUBLIC.filter((k) => env[k]).map((k) => [k, env[k]]));
// The browser's RPC: the public SDF endpoint (a private RPC URL in .env may hold an API key).
config.STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
for (const k of Object.keys(config)) if (/SECRET|SK$/.test(k)) throw new Error(`refusing to publish ${k}`);
fs.mkdirSync(path.join(here, "../public/zk"), { recursive: true });
fs.writeFileSync(path.join(here, "../public/config.json"), JSON.stringify(config, null, 2) + "\n");

const circuits = ["open_private", "withdraw_note", "close_position", "order_auth", "place_limit", "cancel_limit", "merge_notes"];
for (const c of circuits) {
  for (const ext of [".wasm", ".zkey"]) {
    const src = path.join(root, "circuits/keys", c + ext), dst = path.join(here, "../public/zk", c + ext);
    if (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs) fs.copyFileSync(src, dst);
  }
}
console.log(`config.json (${Object.keys(config).length} public values) and ${circuits.length} circuits synced`);
