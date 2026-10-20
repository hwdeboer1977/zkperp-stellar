// Opens a position from a private note, submitted by the relayer:
//   node scripts/open-private.mjs <long|short> <size> <collateral> [ROLE]
// Uses <ROLE>'s smallest unspent note that covers the collateral. On chain:
// a nullifier, the position and change commitments, the keeper note. Not the
// collateral, not <ROLE>'s account.
import { proveOpenPrivate } from "../lib/private.mjs";
import { ownerSecretFor } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { fetchLeaves } from "../lib/tree-fetch.mjs";
import { notesOf, saveNote, markSpent, savePosition } from "../lib/wallet.mjs";
import { relay } from "../lib/relay.mjs";
import { cfg, invoke, secretOf, addressOf } from "../lib/stellar.mjs";

const [side, sizeArg, collArg, role = "TRADER"] = process.argv.slice(2);
if (!["long", "short"].includes(side) || !sizeArg || !collArg) {
  console.error("usage: node scripts/open-private.mjs <long|short> <size> <collateral> [ROLE]");
  process.exit(1);
}
const units = (x) => BigInt(Math.round(Number(x) * 1e4)) * 1000n;
const vault = cfg("VAULT_ID");
const secret = secretOf(role), owner = addressOf(secret), ownerSecret = ownerSecretFor(secret);
const reader = secretOf("RELAYER"); // read-only calls: any funded account
const collateral = units(collArg);
const note = notesOf(vault, owner).find((n) => BigInt(n.amount) >= collateral);
if (!note) { console.error(`no unspent note of ${role} covers ${collArg}; deposit one first`); process.exit(1); }

const tree = await Tree.fromLeaves(fetchLeaves(vault, reader));
if (!invoke({ id: vault, secret: reader, fn: "is_known_root", args: { root: tree.root.toString() }, send: false })) {
  console.error("rebuilt tree root is not known to the vault (missing leaves? see backfill_leaves)");
  process.exit(1);
}
const mark = invoke({ id: vault, secret: reader, fn: "mark_price", send: false });
const config = invoke({ id: vault, secret: reader, fn: "perp_config", send: false });
const openTime = BigInt(Math.floor(Date.now() / 1000) - 20);

console.log(`proving ${side} size=${sizeArg} collateral=${collArg} from note at leaf ${note.leafIndex} (${Number(note.amount) / 1e7})...`);
const t0 = Date.now();
const r = await proveOpenPrivate({ tree, note, ownerSecret, isLong: side === "long", size: units(sizeArg), collateral,
  entryPrice: BigInt(mark.price), openTime, feeBps: config.fee_bps, keeperPk: [config.keeper_key.x, config.keeper_key.y] });
console.log(`proved in ${((Date.now() - t0) / 1000).toFixed(1)} s; relaying...`);
const s = r.soroban;
const leaf = await relay(vault, "open_position_private", {
  root: s.root.toString(), nullifier: s.nullifier, commitment: s.commitment, change: s.change,
  note_r: s.noteR, note: s.note, open_time: openTime.toString(), proof: s.proof,
});
markSpent(vault, note.leafIndex, `open #${leaf}`);
savePosition(vault, leaf, { owner, ...r.position, ownerSecret: "derived from " + role + "_SECRET" });
saveNote(vault, { ...r.change, leafIndex: leaf + 1, owner });
console.log(`opened private position #${leaf} (${side}); change note ${Number(r.change.amount) / 1e7} at leaf ${leaf + 1}`);
process.exit(0);
