import { test, after } from "node:test";
import assert from "node:assert/strict";
import { crypto, randomScalar } from "../lib/keeper.mjs";
import { ownerHashOf } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveClose, settle } from "../lib/close.mjs";
import { verify } from "../lib/private.mjs";

after(() => globalThis.curve_bn128?.terminate?.());
const U = 10_000_000n;
const MAX = 5_000n * U;
const ownerSecret = 4242n, treasurySecret = 777n;

async function position(p) {
  const { poseidon, F } = await crypto();
  const pos = { openTime: 1_792_000_000n, salt: randomScalar(248), ...p };
  pos.openFee = (BigInt(pos.size) * 10n + 9999n) / 10000n;
  const fields = [pos.isLong ? 1n : 0n, pos.size, pos.collateral, pos.entryPrice, pos.openTime, pos.openFee, await ownerHashOf(ownerSecret), pos.salt];
  pos.commitment = F.toObject(poseidon(fields.map(BigInt)));
  return pos;
}

async function close(pos, exitPrice) {
  const tree = await Tree.fromLeaves([5n, pos.commitment]);
  const r = await proveClose({ tree, pos, leafIndex: 1, ownerSecret, exitPrice, closeTime: 1_792_000_600n, feeBps: 10, maxPayout: MAX,
    treasuryOwner: await ownerHashOf(treasurySecret) });
  assert.equal(await verify("close_position", r.proof, r.publicSignals), true);
  assert.equal(r.payoutNote.commitment, r.payoutNote.expected);
  assert.equal(r.feeNote.commitment, r.feeNote.expected);
  // Value is conserved: gross collateral = payout + fees + loss - profit.
  const s = r.settlement;
  assert.equal(BigInt(pos.collateral) + BigInt(pos.openFee), s.payout + s.fees + s.poolIn - s.poolOut);
  assert.deepEqual([BigInt(r.soroban.poolIn), BigInt(r.soroban.poolOut)], [s.poolIn, s.poolOut]);
  return s;
}

test("long in profit: +10% on 5,000 at 10x", async () => {
  const pos = await position({ isLong: true, size: 5_000n * U, collateral: 495n * U, entryPrice: 80_000n * U });
  const s = await close(pos, 88_000n * U);
  assert.equal(s.isProfit, true);
  assert.equal(s.poolOut, 500n * U, "profit of 10% on 5,000 is paid from the pool");
  assert.equal(s.poolIn, 0n);
  assert.equal(s.payout, 495n * U - 5n * U + 500n * U);
});

test("short at a loss, flat close, capped profit, wipe-out", async () => {
  // Short loses when price rises 4%: loss = 200 on 5,000.
  const short = await position({ isLong: false, size: 5_000n * U, collateral: 495n * U, entryPrice: 80_000n * U });
  const s1 = await close(short, 83_200n * U);
  assert.equal([s1.isProfit, s1.poolIn, s1.poolOut].join(), [false, 200n * U, 0n].join());
  // Flat: the pool sees nothing, all the trader pays is fees (in the fee note).
  const s2 = await close(short, 80_000n * U);
  assert.equal([s2.poolIn, s2.poolOut, s2.payout].join(), [0n, 0n, 490n * U].join());
  // Long +100% on 20,000: profit capped at max_payout.
  const big = await position({ isLong: true, size: 20_000n * U, collateral: 1_020n * U, entryPrice: 50_000n * U });
  const s3 = await close(big, 100_000n * U);
  assert.equal(s3.poolOut, MAX - 0n);
  // Long -20% at 10x: the loss takes all the collateral; no fee is left to take.
  const s4 = await close(await position({ isLong: true, size: 5_000n * U, collateral: 495n * U, entryPrice: 80_000n * U }), 64_000n * U);
  assert.equal([s4.poolIn, s4.payout, s4.feeTaken].join(), [495n * U, 0n, 0n].join());
});

test("someone else can't close it, and a wrong PnL can't be proven", async () => {
  const pos = await position({ isLong: true, size: 1_000n * U, collateral: 100n * U, entryPrice: 80_000n * U });
  const tree = await Tree.fromLeaves([pos.commitment]);
  const args = { tree, pos, leafIndex: 0, exitPrice: 81_000n * U, closeTime: 1_792_000_600n, feeBps: 10, maxPayout: MAX, treasuryOwner: 1n };
  await assert.rejects(proveClose({ ...args, ownerSecret: ownerSecret + 1n }));
  await assert.rejects(proveClose({ ...args, ownerSecret, closeTime: 1_791_999_999n }), "before the open");
  const s = settle(pos, args.exitPrice, 10, MAX);
  assert.equal(s.pnl, 12_5000000n); // 1,000 * 1.25% = 12.5
});

test("borrow fee: 0.01% of size per hour (Midnight's rate), out of the equity", async () => {
  const RATE = 27_778n; // per second, x10^12
  const pos = await position({ isLong: true, size: 5_000n * U, collateral: 495n * U, entryPrice: 80_000n * U });
  const tree = await Tree.fromLeaves([5n, pos.commitment]);
  const closeTime = pos.openTime + 3_600n * 24n; // held one day
  const r = await proveClose({ tree, pos, leafIndex: 1, ownerSecret, exitPrice: 80_000n * U, closeTime, feeBps: 10, maxPayout: MAX,
    treasuryOwner: await ownerHashOf(treasurySecret), borrowRate: RATE });
  assert.equal(await verify("close_position", r.proof, r.publicSignals), true);
  const s = r.settlement;
  // 5,000 * 27,778e-12 * 86,400 s = 12.0000960 -> ceil to 7 decimals
  assert.equal(s.borrowFee, 120_000_960n);
  assert.equal(s.payout, 495n * U - 5n * U - 120_000_960n, "flat close pays both fees");
  assert.equal(BigInt(pos.collateral) + BigInt(pos.openFee), s.payout + s.fees + s.poolIn - s.poolOut);
  // A wrong borrow rate in the proof's public inputs can't verify.
  const forged = [...r.publicSignals]; forged[11] = "0";
  assert.equal(await verify("close_position", r.proof, forged), false);
});
