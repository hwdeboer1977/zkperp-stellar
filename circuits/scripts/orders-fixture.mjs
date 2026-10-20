// Real proofs for the vault's trigger-order tests:
//   node scripts/orders-fixture.mjs ../contracts/zkperp-vault/src/fixtures/orders.json
// Fresh vault: deposit 1,000 note (leaf 0) -> private long 4,000 / 400 at P1
// (position leaf 1, change leaf 2) -> owner places a stop loss at 79,000 and a
// take profit at 90,000 -> cancels the take profit -> price falls to 78,500 ->
// keeper executes the stop loss (payout leaf 3, fee leaf 4).
import fs from "node:fs";
import { newKeeperKey, decryptNote } from "../lib/keeper.mjs";
import { newNote, ownerHashOf } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveOpenPrivate } from "../lib/private.mjs";
import { proveOrderAuth, proveExecuteOrder, KIND, newOrderSalt } from "../lib/orders.mjs";
import { vkeyToSoroban } from "../lib/encoding.mjs";

const U = 10_000_000n, ownerSecret = 777n, treasurySecret = 271828n;
const T0 = 1_792_000_000n, P1 = 81_921n * U, P2 = 78_500n * U;
const keeper = await newKeeperKey();
const note = { ...(await newNote(ownerSecret, 1_000n * U)), leafIndex: 0 };
const open = await proveOpenPrivate({ tree: await Tree.fromLeaves([note.commitment]), note, ownerSecret, isLong: true,
  size: 4_000n * U, collateral: 400n * U, entryPrice: P1, openTime: T0, feeBps: 10, keeperPk: keeper.pk });
const tree = await Tree.fromLeaves([note.commitment, BigInt(open.soroban.commitment), BigInt(open.soroban.change)]);
const pos = await decryptNote(keeper.sk, [open.soroban.noteR.x, open.soroban.noteR.y], open.soroban.note);
const owned = { ...pos, isLong: true };
const sl = { kind: KIND.sl, trigger: 79_000n * U, orderSalt: newOrderSalt() };
const tp = { kind: KIND.tp, trigger: 90_000n * U, orderSalt: newOrderSalt() };
const auth = (o, action) => proveOrderAuth({ tree, pos: owned, leafIndex: 1, ownerSecret, ...o, action, keeperPk: keeper.pk });
const placeSl = await auth(sl, 1), placeTp = await auth(tp, 1), cancelTp = await auth(tp, 2);
const exec = await proveExecuteOrder({ tree, pos, leafIndex: 1, ...sl, exitPrice: P2, closeTime: T0 + 590n, feeBps: 10,
  maxPayout: 5_000n * U, treasuryOwner: await ownerHashOf(treasurySecret), borrowRate: 27_778 });

const vk = (n) => vkeyToSoroban(JSON.parse(fs.readFileSync(new URL(`../keys/${n}.vkey.json`, import.meta.url))));
const d = (x) => BigInt(x).toString();
const authJson = (a) => ({ root: d(a.soroban.root), order_id: a.soroban.orderId, note_r: [a.soroban.noteR.x, a.soroban.noteR.y], note: a.soroban.note, proof: a.soroban.proof });
const e = exec.soroban;
fs.writeFileSync(process.argv[2], JSON.stringify({
  keeper_pk: keeper.pk.map(d), treasury_owner: d(await ownerHashOf(treasurySecret)), borrow_rate: 27778,
  open_private_vk: vk("open_private"), withdraw_vk: vk("withdraw_note"), close_vk: vk("close_position"), liquidate_vk: vk("liquidate_position"),
  order_auth_vk: vk("order_auth"), execute_order_vk: vk("execute_order"),
  t0: d(T0), p1: d(P1), p2: d(P2), deposit: { amount: d(note.amount), inner: d(note.inner) },
  open: { root: d(open.soroban.root), nullifier: d(open.soroban.nullifier), commitment: d(open.soroban.commitment), change: d(open.soroban.change),
    note_r: [d(open.soroban.noteR.x), d(open.soroban.noteR.y)], note: open.soroban.note.map(d), proof: open.soroban.proof },
  place_sl: authJson(placeSl), place_tp: authJson(placeTp), cancel_tp: authJson(cancelTp),
  execute: { order_id: e.orderId, root: d(e.root), nullifier: e.nullifier, payout: e.payout, fee: e.fee, pool_in: e.poolIn, pool_out: e.poolOut,
    close_time: d(T0 + 590n), proof: e.proof, payout_amount: exec.settlement.payout.toString() },
}, null, 2) + "\n");
console.log(`orders fixture written: stop loss closes with loss ${Number(exec.settlement.poolIn) / 1e7}, payout ${Number(exec.settlement.payout) / 1e7}`);
process.exit(0);
