import { test, after } from "node:test";
import assert from "node:assert/strict";
import { newKeeperKey, decryptNote } from "../lib/keeper.mjs";
import { newNote } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { provePlaceLimit, proveExecuteLimit, proveCancelLimit, LIMIT_FIELDS, reached } from "../lib/limits.mjs";
import { verify } from "../lib/private.mjs";

after(() => globalThis.curve_bn128?.terminate?.());
const U = 10_000_000n, owner = 2024n;

async function placed(isLong, limitPrice, size = 3_000n * U, collateral = 300n * U) {
  const keeper = await newKeeperKey();
  const note = { ...(await newNote(owner, 1_000n * U)), leafIndex: 0 };
  const tree = await Tree.fromLeaves([note.commitment]);
  const r = await provePlaceLimit({ tree, note, ownerSecret: owner, isLong, size, collateral, limitPrice, keeperPk: keeper.pk });
  return { keeper, r };
}

test("place: verifies, change is right, keepers read the order", async () => {
  const { keeper, r } = await placed(true, 80_000n * U);
  assert.equal(await verify("place_limit", r.proof, r.publicSignals), true);
  assert.equal(r.change.amount, (700n * U).toString());
  const o = await decryptNote(keeper.sk, [r.soroban.noteR.x, r.soroban.noteR.y], r.soroban.note, LIMIT_FIELDS);
  assert.deepEqual([o.isLong, o.size, o.collateral, o.limitPrice], [1n, 3_000n * U, 300n * U, 80_000n * U]);
});

test("fill only once the limit is reached, at the mark price", async () => {
  for (const [isLong, limit, fill, notYet] of [[true, 80_000n, 79_800n, 80_100n], [false, 84_000n, 84_200n, 83_900n]]) {
    const { keeper, r } = await placed(isLong, limit * U);
    const o = await decryptNote(keeper.sk, [r.soroban.noteR.x, r.soroban.noteR.y], r.soroban.note, LIMIT_FIELDS);
    assert.equal(reached(o, fill * U), true);
    const x = await proveExecuteLimit({ o, entryPrice: fill * U, openTime: 1_792_000_000n, feeBps: 10 });
    assert.equal(await verify("execute_limit", x.proof, x.publicSignals), true);
    assert.equal(x.position.entryPrice, fill * U, "opened at the mark, not the limit");
    assert.equal(x.soroban.commitment, x.position.commitment.toString(), "owner/keepers rebuild the same position");
    await assert.rejects(proveExecuteLimit({ o, entryPrice: notYet * U, openTime: 1_792_000_000n, feeBps: 10 }));
  }
});

test("an over-leveraged order can't fill; only the owner can cancel", async () => {
  const { keeper, r } = await placed(true, 80_000n * U, 30_000n * U, 300n * U); // 100x
  const o = await decryptNote(keeper.sk, [r.soroban.noteR.x, r.soroban.noteR.y], r.soroban.note, LIMIT_FIELDS);
  await assert.rejects(proveExecuteLimit({ o, entryPrice: 79_000n * U, openTime: 1_792_000_000n, feeBps: 10 }));
  const c = await proveCancelLimit({ o, ownerSecret: owner });
  assert.equal(await verify("cancel_limit", c.proof, c.publicSignals), true);
  assert.equal(c.refund.commitment, c.soroban.refund);
  await assert.rejects(proveCancelLimit({ o, ownerSecret: owner + 1n }));
});
