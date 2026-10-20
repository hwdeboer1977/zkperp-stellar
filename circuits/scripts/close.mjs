// Closes a position at the mark price, submitted by the relayer:
//   node scripts/close.mjs <position leaf> [ROLE]
// Works for positions opened publicly (step 4) or from a note (step 6). The
// payout becomes a private note of <ROLE>; the fees a note of the treasury.
// Public: the pool's change (loss in / profit out) and the exit price.
import fs from "node:fs";
import { proveClose } from "../lib/close.mjs";
import { ownerSecretFor } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { fetchLeaves } from "../lib/tree-fetch.mjs";
import { saveNote } from "../lib/wallet.mjs";
import { relay } from "../lib/relay.mjs";
import { cfg, invoke, secretOf, addressOf, ROOT } from "../lib/stellar.mjs";

const [leafArg, role = "TRADER"] = process.argv.slice(2);
if (leafArg === undefined) { console.error("usage: node scripts/close.mjs <position leaf> [ROLE]"); process.exit(1); }
const vault = cfg("VAULT_ID");
const file = `${ROOT}.zkperp/positions/${vault}-${leafArg}.json`;
const pos = JSON.parse(fs.readFileSync(file, "utf8"));
if (pos.closed) { console.error(`position #${leafArg} is already closed (${pos.closed})`); process.exit(1); }
const secret = secretOf(role), owner = addressOf(secret);
// Step-4 positions stored a random owner secret; step-6 ones derive it from <ROLE>_SECRET.
const ownerSecret = /^\d+$/.test(String(pos.ownerSecret)) ? BigInt(pos.ownerSecret) : ownerSecretFor(secret);
const reader = secretOf("RELAYER");
const ro = (fn, args) => invoke({ id: vault, secret: reader, fn, args, send: false });

const tree = await Tree.fromLeaves(fetchLeaves(vault, reader));
if (!ro("is_known_root", { root: tree.root.toString() })) { console.error("rebuilt root not known to the vault"); process.exit(1); }
const mark = ro("mark_price"), config = ro("perp_config");
const closeTime = BigInt(Math.floor(Date.now() / 1000) - 20);
const r = await proveClose({ tree, pos, leafIndex: Number(leafArg), ownerSecret, payoutOwnerSecret: ownerSecretFor(secret),
  exitPrice: BigInt(mark.price), closeTime, feeBps: config.fee_bps, maxPayout: BigInt(ro("max_payout")), treasuryOwner: BigInt(ro("treasury_owner")),
  borrowRate: ro("borrow_rate") });
const s = r.settlement, c = r.soroban;
const fmt = (x) => (Number(x) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 7 });
console.log(`closing #${leafArg} ${pos.isLong ? "long" : "short"} ${fmt(pos.size)} @ ${fmt(pos.entryPrice)} -> ${fmt(mark.price)}: ` +
  `${s.isProfit ? "profit" : "loss"} ${fmt(s.pnl)}, fees ${fmt(s.fees)} (borrow ${fmt(s.borrowFee)}), payout ${fmt(s.payout)}`);
const payoutLeaf = await relay(vault, "close_position", {
  root: c.root.toString(), nullifier: c.nullifier, payout: c.payout, fee: c.fee, pool_in: c.poolIn, pool_out: c.poolOut,
  close_time: closeTime.toString(), proof: c.proof,
});
saveNote(vault, { ...r.payoutNote, leafIndex: payoutLeaf, owner });
saveNote(vault, { ...r.feeNote, leafIndex: payoutLeaf + 1, owner: "treasury" });
fs.writeFileSync(file, JSON.stringify({ ...pos, closed: { exitPrice: mark.price, payout: s.payout.toString(), payoutLeaf } }, null, 2) + "\n", { mode: 0o600 });
console.log(`closed #${leafArg}; payout note ${fmt(s.payout)} at leaf ${payoutLeaf}, treasury fee note at leaf ${payoutLeaf + 1}`);
process.exit(0);
