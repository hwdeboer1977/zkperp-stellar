// Lists <ROLE>'s notes on the vault and whether each is spent on chain:
//   node scripts/notes.mjs [ROLE]
import { cfg, invoke, secretOf, addressOf } from "../lib/stellar.mjs";
import { nullifierOf } from "../lib/notes.mjs";
import { notesOf } from "../lib/wallet.mjs";

const role = process.argv[2] ?? "TRADER";
const vault = cfg("VAULT_ID");
const secret = secretOf(role);
let total = 0n;
for (const n of notesOf(vault, addressOf(secret), { includeSpent: true })) {
  const spent = invoke({ id: vault, secret, fn: "is_spent", args: { nullifier: (await nullifierOf(n.salt, n.leafIndex)).toString() }, send: false });
  if (!spent) total += BigInt(n.amount);
  console.log(`leaf ${String(n.leafIndex).padStart(3)}  ${(Number(n.amount) / 1e7).toLocaleString("en-US")} mUSDC  ${spent ? "spent" : "unspent"}${n.spent ? ` (${n.spent})` : ""}`);
}
console.log(`unspent total: ${(Number(total) / 1e7).toLocaleString("en-US")} mUSDC`);
process.exit(0);
