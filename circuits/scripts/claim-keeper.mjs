// A keeper claims its share of collected fees:  node scripts/claim-keeper.mjs --keeper <n>
// Adds the keeper account's collateral trustline first if it has none
// (a classic account can't receive mUSDC without one).
import { execFileSync } from "node:child_process";
import { cfg, invoke, secretOf, addressOf } from "../lib/stellar.mjs";

const i = process.argv.indexOf("--keeper");
const n = Number(process.argv[i + 1]);
if (![1, 2, 3].includes(n)) { console.error("usage: node scripts/claim-keeper.mjs --keeper <1|2|3>"); process.exit(1); }
const secret = secretOf(`KEEPER_${n}`), me = addressOf(secret), vault = cfg("VAULT_ID");
const owed = invoke({ id: vault, secret, fn: "keeper_owed", args: { keeper: me }, send: false });
if (BigInt(owed) <= 0n) { console.log(`keeper ${n}: nothing to claim`); process.exit(0); }

const asset = `${cfg("MUSDC_CODE")}:${cfg("MUSDC_ISSUER")}`;
const account = JSON.parse(execFileSync("curl", ["-s", `https://horizon-testnet.stellar.org/accounts/${me}`], { encoding: "utf8" }));
const hasLine = (account.balances ?? []).some((b) => `${b.asset_code}:${b.asset_issuer}` === asset);
if (!hasLine) {
  execFileSync("stellar", ["tx", "new", "change-trust", "--line", asset, "--network", "testnet"],
    { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, STELLAR_ACCOUNT: secret } });
  console.log(`keeper ${n}: added ${cfg("MUSDC_CODE")} trustline`);
}
const paid = invoke({ id: vault, secret, fn: "claim_keeper_fees", args: { keeper: me } });
console.log(`keeper ${n} claimed ${Number(paid) / 1e7} mUSDC`);
