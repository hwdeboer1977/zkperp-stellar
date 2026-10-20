import { test, after } from "node:test";
import assert from "node:assert/strict";
import { crypto, newKeeperKey, decryptNote } from "../lib/keeper.mjs";
import { ownerHashOf } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveOrderAuth, proveExecuteOrder, orderIdOf, fires, ORDER_FIELDS, KIND, newOrderSalt } from "../lib/orders.mjs";
import { verify } from "../lib/private.mjs";
import { randomScalar } from "../lib/keeper.mjs";

after(() => globalThis.curve_bn128?.terminate?.());
const U = 10_000_000n, owner = 4242n;
const base = { feeBps: 10, maxPayout: 5_000n * U, treasuryOwner: 9n, borrowRate: 27_778 };

async function position(isLong) {
  const { poseidon, F } = await crypto();
  const pos = { isLong, size: 4_000n * U, collateral: 396n * U, entryPrice: 80_000n * U, openTime: 1_792_000_000n, openFee: 4n * U,
    salt: randomScalar(248), ownerHash: await ownerHashOf(owner) };
  pos.commitment = F.toObject(poseidon([isLong ? 1n : 0n, pos.size, pos.collateral, pos.entryPrice, pos.openTime, pos.openFee, pos.ownerHash, pos.salt]));
  return pos;
}

test("firing rule for all four orders", async () => {
  const L = await position(true), S = await position(false);
  const T = 76_000n * U, up = 84_000n * U;
  assert.equal(fires(L, KIND.sl, T, 75_000n * U), true, "long SL fires at or below");
  assert.equal(fires(L, KIND.sl, T, 77_000n * U), false);
  assert.equal(fires(S, KIND.sl, up, 85_000n * U), true, "short SL fires at or above");
  assert.equal(fires(S, KIND.sl, up, 83_000n * U), false);
  assert.equal(fires(L, KIND.tp, up, 84_000n * U), true, "long TP fires at or above");
  assert.equal(fires(L, KIND.tp, up, 83_999n * U), false);
  assert.equal(fires(S, KIND.tp, T, 76_000n * U), true, "short TP fires at or below");
  assert.equal(fires(S, KIND.tp, T, 76_001n * U), false);
});

test("owner places and cancels; keepers read the order; a stranger can't", async () => {
  const keeper = await newKeeperKey();
  const pos = await position(true);
  const tree = await Tree.fromLeaves([1n, 2n, pos.commitment]);
  const orderSalt = newOrderSalt();
  const args = { tree, pos, leafIndex: 2, kind: KIND.sl, trigger: 76_000n * U, orderSalt, keeperPk: keeper.pk };
  const place = await proveOrderAuth({ ...args, ownerSecret: owner, action: 1 });
  assert.equal(await verify("order_auth", place.proof, place.publicSignals), true);
  assert.equal(place.soroban.orderId, (await orderIdOf(pos.salt, KIND.sl, 76_000n * U, orderSalt)).toString());
  const d = await decryptNote(keeper.sk, [place.soroban.noteR.x, place.soroban.noteR.y], place.soroban.note, ORDER_FIELDS);
  assert.deepEqual([d.leafIndex, d.kind, d.trigger, d.orderSalt], [2n, 0n, 76_000n * U, orderSalt]);
  const cancel = await proveOrderAuth({ ...args, ownerSecret: owner, action: 2 });
  assert.equal(await verify("order_auth", cancel.proof, cancel.publicSignals), true);
  const replay = [...place.publicSignals]; replay[8] = "2"; // place proof re-labelled as a cancel
  assert.equal(await verify("order_auth", place.proof, replay), false);
  await assert.rejects(proveOrderAuth({ ...args, ownerSecret: owner + 1n, action: 1 }));
});

test("keeper executes each order type only once its level is crossed", async () => {
  for (const [isLong, kind, trigger, crossedAt, notYet] of [
    [true, KIND.sl, 76_000n, 75_500n, 76_500n], [false, KIND.sl, 84_000n, 84_500n, 83_500n],
    [true, KIND.tp, 84_000n, 84_000n, 83_000n], [false, KIND.tp, 76_000n, 75_000n, 77_000n]]) {
    const pos = await position(isLong);
    const tree = await Tree.fromLeaves([pos.commitment]);
    const o = { tree, pos, leafIndex: 0, kind, trigger: trigger * U, orderSalt: newOrderSalt(), closeTime: pos.openTime + 600n, ...base };
    const r = await proveExecuteOrder({ ...o, exitPrice: crossedAt * U });
    assert.equal(await verify("execute_order", r.proof, r.publicSignals), true);
    assert.equal(r.payoutNote.commitment, r.soroban.payout, "owner can recompute the payout note");
    await assert.rejects(proveExecuteOrder({ ...o, exitPrice: notYet * U }), `${isLong ? "long" : "short"} kind ${kind} not crossed`);
  }
});
