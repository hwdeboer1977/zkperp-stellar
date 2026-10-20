// Writes real open_private + withdraw_note proofs for the vault's Rust tests:
//   node scripts/notes-fixture.mjs ../contracts/zkperp-vault/src/fixtures/notes.json
// Sequence in a fresh vault: deposit note (leaf 0) -> private open from it
// (position leaf 1, change leaf 2) -> withdraw 100 from the change note.
import fs from "node:fs";
import { newKeeperKey } from "../lib/keeper.mjs";
import { newNote, recipientField } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveOpenPrivate, proveWithdraw } from "../lib/private.mjs";
import { vkeyToSoroban, hex32 } from "../lib/encoding.mjs";

const UNIT = 10_000_000n;
const ownerSecret = 987654321987654321n;
const keeper = await newKeeperKey();
const note = { ...(await newNote(ownerSecret, 1_000n * UNIT)), leafIndex: 0 };
const t0 = await Tree.fromLeaves([note.commitment]);
const price = 81_921n * UNIT, openTime = 1_792_000_000n;
const open = await proveOpenPrivate({ tree: t0, note, ownerSecret, isLong: true, size: 4_000n * UNIT, collateral: 400n * UNIT,
  entryPrice: price, openTime, feeBps: 10, keeperPk: keeper.pk });

const t1 = await Tree.fromLeaves([note.commitment, BigInt(open.soroban.commitment), BigInt(open.soroban.change)]);
// A contract address: in the Rust test environment a G account would need an mUSDC trustline.
const recipient = "CBDVQDAANRFPVIMY46GR67TXZ5LJYZY42YMVOJECBTQZOZUNH42O63LV";
const change = { amount: open.change.amount, salt: open.change.salt, leafIndex: 2 };
const wd = await proveWithdraw({ tree: t1, note: change, ownerSecret, amount: 100n * UNIT, recipient: recipientField(recipient) });

const vk = (n) => vkeyToSoroban(JSON.parse(fs.readFileSync(new URL(`../keys/${n}.vkey.json`, import.meta.url))));
const dec = (x) => BigInt(x).toString();
fs.writeFileSync(process.argv[2], JSON.stringify({
  keeper_pk: keeper.pk.map(dec), open_private_vk: vk("open_private"), withdraw_vk: vk("withdraw_note"),
  deposit: { amount: dec(note.amount), inner: dec(note.inner), commitment: dec(note.commitment), root: dec(t0.root) },
  open: { price: dec(price), open_time: dec(openTime), fee_bps: 10, root: dec(open.soroban.root), nullifier: dec(open.soroban.nullifier),
    commitment: dec(open.soroban.commitment), change: dec(open.soroban.change), note_r: [dec(open.soroban.noteR.x), dec(open.soroban.noteR.y)],
    note: open.soroban.note.map(dec), proof: open.soroban.proof, root_after: dec(t1.root) },
  withdraw: { recipient, recipient_field: dec(recipientField(recipient)), amount: dec(100n * UNIT), root: dec(wd.soroban.root),
    nullifier: dec(wd.soroban.nullifier), change: dec(wd.soroban.change), proof: wd.soroban.proof },
}, null, 2) + "\n");
console.log("notes fixture written");
process.exit(0);
