import { test, after } from "node:test";
import assert from "node:assert/strict";
import { newKeeperKey, decryptNote, positionCommitment } from "../lib/keeper.mjs";
import { proveOpen, verifyOpen } from "../lib/open.mjs";

const UNIT = 10_000_000n;
const base = { entryPrice: 60_000n * UNIT, openTime: 1_760_000_000n, feeBps: 10 };

after(() => globalThis.curve_bn128?.terminate?.());

test("long and short opens verify, and keepers can read them", async () => {
  const keeper = await newKeeperKey();
  for (const isLong of [true, false]) {
    const r = await proveOpen({ ...base, isLong, size: 5_000n * UNIT, collateral: 500n * UNIT, keeperPk: keeper.pk });
    assert.equal(await verifyOpen(r.proof, r.publicSignals), true);
    // fee = ceil(5000 * 10 / 10000) = 5 mUSDC; net collateral 495; leverage ~10.1x
    assert.equal(r.position.openFee, (5n * UNIT).toString());
    const d = await decryptNote(keeper.sk, r.publicSignals.slice(1, 3), r.publicSignals.slice(3, 11));
    assert.equal(d.isLong, isLong ? 1n : 0n);
    assert.equal(d.size, 5_000n * UNIT);
    assert.equal(d.collateral, 495n * UNIT);
    assert.equal(d.salt.toString(), r.position.salt);
    assert.equal((await positionCommitment(d)).toString(), r.publicSignals[0]);
  }
});

test("a different key cannot read the note", async () => {
  const [keeper, other] = [await newKeeperKey(), await newKeeperKey()];
  const r = await proveOpen({ ...base, isLong: true, size: 1_000n * UNIT, collateral: 100n * UNIT, keeperPk: keeper.pk });
  const d = await decryptNote(other.sk, r.publicSignals.slice(1, 3), r.publicSignals.slice(3, 11));
  assert.notEqual(d.size, 1_000n * UNIT);
});

test("leverage above 20x or below 1x cannot be proven", async () => {
  const keeper = await newKeeperKey();
  // net = 100 - 2.1 = 97.9; 21x of that is above the cap
  await assert.rejects(proveOpen({ ...base, isLong: true, size: 2_100n * UNIT, collateral: 100n * UNIT, keeperPk: keeper.pk }));
  await assert.rejects(proveOpen({ ...base, isLong: true, size: 50n * UNIT, collateral: 100n * UNIT, keeperPk: keeper.pk }));
});
