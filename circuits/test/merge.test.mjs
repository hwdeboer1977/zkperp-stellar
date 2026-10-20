import { test, after } from "node:test";
import assert from "node:assert/strict";
import { newNote } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveMerge, verify } from "../lib/private.mjs";

after(() => globalThis.curve_bn128?.terminate?.());
const U = 10_000_000n;

test("merges two notes of the same owner; not someone else's", async () => {
  const a = { ...(await newNote(5n, 10n * U)), leafIndex: 0 };
  const b = { ...(await newNote(5n, 32n * U)), leafIndex: 2 };
  const other = { ...(await newNote(6n, 1n * U)), leafIndex: 1 };
  const tree = await Tree.fromLeaves([a.commitment, other.commitment, b.commitment]);
  const r = await proveMerge({ tree, a, b, ownerSecret: 5n });
  assert.equal(await verify("merge_notes", r.proof, r.publicSignals), true);
  assert.equal(r.merged.amount, (42n * U).toString());
  assert.notEqual(r.soroban.nullifierA, r.soroban.nullifierB);
  await assert.rejects(proveMerge({ tree, a, b: other, ownerSecret: 5n }), "other owner's note");
});
