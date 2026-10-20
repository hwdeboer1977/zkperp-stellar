// Deposits mUSDC as a private note:  node scripts/note-deposit.mjs <amount> [ROLE]
// Public: the amount and <ROLE>'s address (a token transfer). Private from
// here on: which later open or withdrawal spends this note.
import { cfg, invoke, secretOf, addressOf } from "../lib/stellar.mjs";
import { ownerSecretFor, newNote } from "../lib/notes.mjs";
import { saveNote } from "../lib/wallet.mjs";

const [amountArg, role = "TRADER"] = process.argv.slice(2);
if (!amountArg) { console.error("usage: node scripts/note-deposit.mjs <amount> [ROLE]"); process.exit(1); }
const vault = cfg("VAULT_ID");
const secret = secretOf(role), owner = addressOf(secret);
const amount = BigInt(Math.round(Number(amountArg) * 1e4)) * 1000n;
const note = await newNote(ownerSecretFor(secret), amount);
const leafIndex = invoke({ id: vault, secret, fn: "deposit_note", args: { from: owner, amount: amount.toString(), inner: note.inner.toString() } });
saveNote(vault, { ...note, leafIndex, owner });
console.log(`deposited ${amountArg} as note at leaf ${leafIndex}`);
process.exit(0);
