import { test, after } from "node:test";
import assert from "node:assert/strict";
import { newKeeperKey, decryptNote, positionCommitment } from "../lib/keeper.mjs";
import { newNote, nullifierOf, ownerHashOf } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveOpenPrivate, proveWithdraw, verify } from "../lib/private.mjs";

const UNIT = 10_000_000n;
const ownerSecret = 123456789n;

after(() => globalThis.curve_bn128?.terminate?.());

test("open from a note: verifies, nullifier and change are right, keeper reads it", async () => {
  const keeper = await newKeeperKey();
  const note = { ...(await newNote(ownerSecret, 1_000n * UNIT)), leafIndex: 2 };
  const tree = await Tree.fromLeaves([11n, 22n, note.commitment]);
  const r = await proveOpenPrivate({ tree, note, ownerSecret, isLong: false, size: 3_000n * UNIT, collateral: 400n * UNIT,
    entryPrice: 81_921n * UNIT, openTime: 1_792_000_000n, feeBps: 10, keeperPk: keeper.pk });
  assert.equal(await verify("open_private", r.proof, r.publicSignals), true);
  assert.equal(r.soroban.nullifier, (await nullifierOf(note.salt, 2)).toString());
  assert.equal(r.change.commitment, r.change.expected);
  assert.equal(r.change.amount, (600n * UNIT).toString());
  const d = await decryptNote(keeper.sk, [r.soroban.noteR.x, r.soroban.noteR.y], r.soroban.note);
  assert.equal(d.isLong, 0n);
  assert.equal(d.ownerHash, await ownerHashOf(ownerSecret));
  assert.equal((await positionCommitment(d)).toString(), r.soroban.commitment);
});

test("can't spend more than the note, or someone else's note", async () => {
  const keeper = await newKeeperKey();
  const note = { ...(await newNote(ownerSecret, 100n * UNIT)), leafIndex: 0 };
  const tree = await Tree.fromLeaves([note.commitment]);
  const base = { tree, note, isLong: true, size: 1_000n * UNIT, entryPrice: 81_921n * UNIT, openTime: 1_792_000_000n, feeBps: 10, keeperPk: keeper.pk };
  await assert.rejects(proveOpenPrivate({ ...base, ownerSecret, collateral: 101n * UNIT }));
  await assert.rejects(proveOpenPrivate({ ...base, ownerSecret: ownerSecret + 1n, collateral: 100n * UNIT }));
  await assert.rejects(proveWithdraw({ tree, note, ownerSecret, amount: 101n * UNIT, recipient: 5n }));
});

test("withdraw verifies and leaves the right change", async () => {
  const note = { ...(await newNote(ownerSecret, 250n * UNIT)), leafIndex: 1 };
  const tree = await Tree.fromLeaves([7n, note.commitment]);
  const r = await proveWithdraw({ tree, note, ownerSecret, amount: 100n * UNIT, recipient: 42n });
  assert.equal(await verify("withdraw_note", r.proof, r.publicSignals), true);
  assert.equal(r.change.amount, (150n * UNIT).toString());
  assert.deepEqual(r.publicSignals.slice(2), [tree.root.toString(), (100n * UNIT).toString(), "42"]);
});
