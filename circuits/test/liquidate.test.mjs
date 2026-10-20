import { test, after } from "node:test";
import assert from "node:assert/strict";
import { crypto, randomScalar } from "../lib/keeper.mjs";
import { ownerHashOf } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveLiquidation, settleLiquidation } from "../lib/liquidate.mjs";
import { verify } from "../lib/private.mjs";

after(() => globalThis.curve_bn128?.terminate?.());
const U = 10_000_000n;
const P = { feeBps: 10, maintenanceBps: 250, liqFeeBps: 50 };

async function position(p) {
  const { poseidon, F } = await crypto();
  const pos = { openTime: 1_792_000_000n, salt: randomScalar(248), ownerHash: await ownerHashOf(99n), ...p };
  pos.openFee = (BigInt(pos.size) * 10n + 9999n) / 10000n;
  pos.commitment = F.toObject(poseidon([pos.isLong ? 1n : 0n, pos.size, pos.collateral, pos.entryPrice, pos.openTime, pos.openFee, pos.ownerHash, pos.salt].map(BigInt)));
  return pos;
}

const liquidate = async (pos, exitPrice) => {
  const tree = await Tree.fromLeaves([7n, pos.commitment]);
  return proveLiquidation({ tree, pos, leafIndex: 1, exitPrice, liqTime: 1_792_000_900n, treasuryOwner: 5n, ...P });
};

test("a 10x long after -8% is below maintenance and liquidates", async () => {
  const pos = await position({ isLong: true, size: 4_000n * U, collateral: 396n * U, entryPrice: 80_000n * U });
  const r = await liquidate(pos, 73_600n * U);
  assert.equal(await verify("liquidate_position", r.proof, r.publicSignals), true);
  const s = r.settlement;
  // loss 320, close fee 4 -> equity 72 < 2.5% of 4,000 = 100; liquidation fee 20 -> owner gets 52
  assert.deepEqual([s.lossAmt, s.equity, s.liqTaken, s.back], [320n * U, 72n * U, 20n * U, 52n * U]);
  assert.equal(BigInt(pos.collateral) + BigInt(pos.openFee), s.back + s.fees + s.poolIn, "value conserved");
  assert.equal(r.payoutNote.commitment, r.soroban.payout, "the owner can recompute their payout note");
});

test("a short wiped out pays the owner nothing and takes no fees beyond the collateral", async () => {
  const pos = await position({ isLong: false, size: 4_000n * U, collateral: 396n * U, entryPrice: 80_000n * U });
  const r = await liquidate(pos, 90_000n * U);
  assert.deepEqual([r.settlement.poolIn, r.settlement.back, r.settlement.liqTaken], [396n * U, 0n, 0n]);
});

test("healthy or profitable positions can't be liquidated", async () => {
  const pos = await position({ isLong: true, size: 4_000n * U, collateral: 396n * U, entryPrice: 80_000n * U });
  assert.equal(settleLiquidation(pos, 78_400n * U, 10, 250, 50).liquidatable, false, "-2%: equity 316 > 100");
  await assert.rejects(liquidate(pos, 78_400n * U));
  await assert.rejects(liquidate(pos, 88_000n * U), "in profit");
  const flat20x = await position({ isLong: true, size: 2_000n * U, collateral: 100n * U, entryPrice: 80_000n * U });
  await assert.rejects(liquidate(flat20x, 80_000n * U), "flat at 20x is still above 2.5%");
});

test("borrow fee counts toward liquidation: a position held long enough becomes liquidatable", async () => {
  const pos = await position({ isLong: true, size: 4_000n * U, collateral: 396n * U, entryPrice: 80_000n * U });
  const RATE = 27_778n;
  // At -7% the loss alone leaves equity 112 > 100 ...
  assert.equal(settleLiquidation(pos, 74_400n * U, 10, 250, 50).liquidatable, false);
  // ... but after 2 days of borrow fees (~19.2) it is below maintenance.
  const liqTime = pos.openTime + 2n * 86_400n;
  const s = settleLiquidation(pos, 74_400n * U, 10, 250, 50, { rate: RATE, time: liqTime });
  assert.equal(s.liquidatable, true);
  const tree = await Tree.fromLeaves([7n, pos.commitment]);
  const r = await proveLiquidation({ tree, pos, leafIndex: 1, exitPrice: 74_400n * U, liqTime, treasuryOwner: 5n, ...P, borrowRate: RATE });
  assert.equal(await verify("liquidate_position", r.proof, r.publicSignals), true);
  assert.equal(BigInt(pos.collateral) + BigInt(pos.openFee), r.settlement.back + r.settlement.fees + r.settlement.poolIn);
});
