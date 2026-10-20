// Real proofs for the vault's limit-order tests:
//   node scripts/limits-fixture.mjs ../contracts/zkperp-vault/src/fixtures/limits.json
// Fresh vault: deposit 1,000 note (leaf 0) -> place limit A: long 3,000 / 300
// at 80,000 (change 700, leaf 1) -> place limit B from the change: short
// 2,000 / 200 at 90,000 (change 500, leaf 2) -> price 79,800: keeper fills A
// (position leaf 3) -> owner cancels B (refund leaf 4).
import fs from "node:fs";
import { newKeeperKey, decryptNote } from "../lib/keeper.mjs";
import { newNote } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { provePlaceLimit, proveExecuteLimit, proveCancelLimit, LIMIT_FIELDS } from "../lib/limits.mjs";
import { vkeyToSoroban } from "../lib/encoding.mjs";

const U = 10_000_000n, owner = 8888n, T0 = 1_792_000_000n, FILL = 79_800n * U;
const keeper = await newKeeperKey();
const note = { ...(await newNote(owner, 1_000n * U)), leafIndex: 0 };
const a = await provePlaceLimit({ tree: await Tree.fromLeaves([note.commitment]), note, ownerSecret: owner, isLong: true,
  size: 3_000n * U, collateral: 300n * U, limitPrice: 80_000n * U, keeperPk: keeper.pk });
const change = { ...a.change, leafIndex: 1 };
const b = await provePlaceLimit({ tree: await Tree.fromLeaves([note.commitment, BigInt(a.soroban.change)]), note: change, ownerSecret: owner, isLong: false,
  size: 2_000n * U, collateral: 200n * U, limitPrice: 90_000n * U, keeperPk: keeper.pk });
const oA = await decryptNote(keeper.sk, [a.soroban.noteR.x, a.soroban.noteR.y], a.soroban.note, LIMIT_FIELDS);
const fill = await proveExecuteLimit({ o: oA, entryPrice: FILL, openTime: T0 + 590n, feeBps: 10 });
const cancel = await proveCancelLimit({ o: b.order, ownerSecret: owner });
const vk = (n) => vkeyToSoroban(JSON.parse(fs.readFileSync(new URL(`../keys/${n}.vkey.json`, import.meta.url))));
const d = (x) => BigInt(x).toString();
const place = (r) => ({ root: d(r.soroban.root), nullifier: r.soroban.nullifier, order: r.soroban.order, change: r.soroban.change,
  note_r: [r.soroban.noteR.x, r.soroban.noteR.y], note: r.soroban.note, proof: r.soroban.proof });
fs.writeFileSync(process.argv[2], JSON.stringify({
  keeper_pk: keeper.pk.map(d), place_vk: vk("place_limit"), execute_vk: vk("execute_limit"), cancel_vk: vk("cancel_limit"),
  open_private_vk: vk("open_private"), withdraw_vk: vk("withdraw_note"), liquidate_vk: vk("liquidate_position"), close_vk: vk("close_position"),
  t0: d(T0), fill_price: d(FILL), deposit: { amount: d(note.amount), inner: d(note.inner) },
  place_a: place(a), place_b: place(b),
  fill: { order: fill.soroban.order, commitment: fill.soroban.commitment, open_time: d(T0 + 590n), proof: fill.soroban.proof },
  cancel: { order: cancel.soroban.order, refund: cancel.soroban.refund, proof: cancel.soroban.proof },
}, null, 2) + "\n");
console.log("limits fixture written");
process.exit(0);
