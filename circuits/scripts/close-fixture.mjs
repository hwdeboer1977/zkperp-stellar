// Writes real proofs for the vault's close tests:
//   node scripts/close-fixture.mjs ../contracts/zkperp-vault/src/fixtures/close.json
// Fresh vault: deposit 1,000 note (leaf 0) -> private long 4,000 / 400 at P1
// (position leaf 1, change leaf 2) -> price rises 5% to P2 -> close
// (payout note leaf 3, treasury fee note leaf 4).
import fs from "node:fs";
import { newKeeperKey } from "../lib/keeper.mjs";
import { newNote, ownerHashOf } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveOpenPrivate } from "../lib/private.mjs";
import { proveClose } from "../lib/close.mjs";
import { vkeyToSoroban } from "../lib/encoding.mjs";

const U = 10_000_000n;
const ownerSecret = 31337n, treasurySecret = 271828n;
const T0 = 1_792_000_000n, P1 = 81_921n * U, P2 = 86_017_0500000n; // +5%
const keeper = await newKeeperKey();
const note = { ...(await newNote(ownerSecret, 1_000n * U)), leafIndex: 0 };
const open = await proveOpenPrivate({ tree: await Tree.fromLeaves([note.commitment]), note, ownerSecret, isLong: true,
  size: 4_000n * U, collateral: 400n * U, entryPrice: P1, openTime: T0, feeBps: 10, keeperPk: keeper.pk });
const tree = await Tree.fromLeaves([note.commitment, BigInt(open.soroban.commitment), BigInt(open.soroban.change)]);
const pos = { ...open.position, isLong: true };
const treasuryOwner = await ownerHashOf(treasurySecret);
const close = await proveClose({ tree, pos, leafIndex: 1, ownerSecret, exitPrice: P2, closeTime: T0 + 590n, feeBps: 10,
  maxPayout: 5_000n * U, treasuryOwner, borrowRate: 27_778 });

const vk = (n) => vkeyToSoroban(JSON.parse(fs.readFileSync(new URL(`../keys/${n}.vkey.json`, import.meta.url))));
const d = (x) => BigInt(x).toString();
const s = open.soroban, c = close.soroban;
fs.writeFileSync(process.argv[2], JSON.stringify({
  keeper_pk: keeper.pk.map(d), treasury_owner: d(treasuryOwner), borrow_rate: 27778,
  open_private_vk: vk("open_private"), withdraw_vk: vk("withdraw_note"), close_vk: vk("close_position"),
  t0: d(T0), p1: d(P1), p2: d(P2),
  deposit: { amount: d(note.amount), inner: d(note.inner) },
  open: { root: d(s.root), nullifier: d(s.nullifier), commitment: d(s.commitment), change: d(s.change),
    note_r: [d(s.noteR.x), d(s.noteR.y)], note: s.note.map(d), proof: s.proof },
  close: { root: d(c.root), nullifier: d(c.nullifier), payout: d(c.payout), fee: d(c.fee), pool_in: d(c.poolIn), pool_out: d(c.poolOut),
    close_time: d(T0 + 590n), proof: c.proof, payout_amount: close.settlement.payout.toString(), fees: close.settlement.fees.toString() },
}, null, 2) + "\n");
console.log(`close fixture written: pool_out ${Number(close.settlement.poolOut) / 1e7}, payout ${Number(close.settlement.payout) / 1e7}, fees ${Number(close.settlement.fees) / 1e7}`);
process.exit(0);
