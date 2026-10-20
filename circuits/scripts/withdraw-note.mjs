// Withdraws from a private note to a public address, via the relayer:
//   node scripts/withdraw-note.mjs <amount> <recipient G.../C... or ROLE> [ROLE]
// Public: the amount and the recipient. Not which note, not <ROLE>'s account.
import { proveWithdraw } from "../lib/private.mjs";
import { ownerSecretFor, recipientField } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { fetchLeaves } from "../lib/tree-fetch.mjs";
import { notesOf, saveNote, markSpent } from "../lib/wallet.mjs";
import { relay } from "../lib/relay.mjs";
import { cfg, invoke, secretOf, addressOf } from "../lib/stellar.mjs";

const [amountArg, to, role = "TRADER"] = process.argv.slice(2);
if (!amountArg || !to) { console.error("usage: node scripts/withdraw-note.mjs <amount> <recipient|ROLE> [ROLE]"); process.exit(1); }
const vault = cfg("VAULT_ID");
const secret = secretOf(role), owner = addressOf(secret);
const recipient = /^[GC][A-Z2-7]{55}$/.test(to) ? to : cfg(`${to}_ADDRESS`);
const reader = secretOf("RELAYER");
const amount = BigInt(Math.round(Number(amountArg) * 1e4)) * 1000n;
const note = notesOf(vault, owner).find((n) => BigInt(n.amount) >= amount);
if (!note) { console.error(`no unspent note of ${role} covers ${amountArg}`); process.exit(1); }

const tree = await Tree.fromLeaves(fetchLeaves(vault, reader));
const r = await proveWithdraw({ tree, note, ownerSecret: ownerSecretFor(secret), amount, recipient: recipientField(recipient) });
const changeLeaf = await relay(vault, "withdraw_note", {
  root: tree.root.toString(), nullifier: r.soroban.nullifier, amount: amount.toString(), recipient, change: r.soroban.change, proof: r.soroban.proof,
});
markSpent(vault, note.leafIndex, `withdraw ${amountArg}`);
saveNote(vault, { ...r.change, leafIndex: changeLeaf, owner });
console.log(`withdrew ${amountArg} to ${recipient}; change note ${Number(r.change.amount) / 1e7} at leaf ${changeLeaf}`);
process.exit(0);
