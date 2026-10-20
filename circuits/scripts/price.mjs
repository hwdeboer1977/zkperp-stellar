// Sets a TEST price, signed locally by two signers (ORACLE_1_SECRET, ORACLE_2_SECRET):
//   node scripts/price.mjs <price>          e.g. 55000 for a crash scenario
// Uses round = current + 1 and updatedAt = now - 10 s. Don't run it on a vault
// whose relayers are running: a test round can block the next Chainlink round
// (rounds only move forward).
import { priceDigest, sign } from "../lib/oracle.mjs";
import { cfg, invoke, secretOf } from "../lib/stellar.mjs";

const vault = cfg("VAULT_ID");
const usd = process.argv[2];
if (!usd) { console.error("usage: node scripts/price.mjs <price>"); process.exit(1); }
const price = BigInt(Math.round(Number(usd) * 1e4)) * 1000n; // 7 decimals
const secret = (k) => secretOf(`ORACLE_${k}`);
let round = 1n;
try { round = BigInt(invoke({ id: vault, secret: secret(1), fn: "mark_price", send: false }).round) + 1n; } catch {}
const updatedAt = BigInt(Math.floor(Date.now() / 1000) - 10);
const d = priceDigest(vault, round, price, updatedAt);
invoke({ id: vault, secret: secret(1), fn: "set_price",
  args: { round: round.toString(), price: price.toString(), updated_at: updatedAt.toString(), first: 0, second: 1,
    sig_a: sign(secret(1), d), sig_b: sign(secret(2), d) } });
console.log(`price set to ${usd} (round ${round})`);
