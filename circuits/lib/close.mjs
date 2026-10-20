// Closing a position: the settlement maths (mirrors close_position.circom
// exactly) and the prover.
import * as snarkjs from "snarkjs";
import { keyPath } from "./zkkeys.mjs";
import { crypto, randomScalar } from "./keeper.mjs";
import { ceilDiv } from "./open.mjs";
import { noteInner, noteCommitment, ownerHashOf } from "./notes.mjs";
import { proofToSoroban } from "./encoding.mjs";

const keys = keyPath;
const min = (a, b) => (a < b ? a : b);

const SCALE = 1_000_000_000_000n;

/** Borrow fee (step 10): ceil(size * rate * held / 10^12). */
export const borrowFeeOf = (pos, borrowRate, time) =>
  ceilDiv(BigInt(pos.size) * BigInt(borrowRate ?? 0) * (BigInt(time ?? pos.openTime) - BigInt(pos.openTime)), SCALE);

/**
 * Settlement of `pos` at `exitPrice` (all BigInt). Pool and trader amounts.
 * `borrow` = { rate, time }: the borrow rate (per second, x10^12) and the close time.
 */
export function settle(pos, exitPrice, feeBps, maxPayout, borrow = {}) {
  const size = BigInt(pos.size), entry = BigInt(pos.entryPrice), net = BigInt(pos.collateral), openFee = BigInt(pos.openFee);
  const exit = BigInt(exitPrice);
  const rose = entry <= exit, fell = exit <= entry;
  const isProfit = pos.isLong ? rose : fell;
  const delta = size * (rose ? exit - entry : entry - exit);
  const pnl = isProfit ? min(delta / entry, BigInt(maxPayout)) : ceilDiv(delta, entry);
  const closeFee = ceilDiv(size * BigInt(feeBps), 10000n);
  const borrowFee = borrowFeeOf(pos, borrow.rate, borrow.time);
  const lossAmt = isProfit ? 0n : min(pnl, net);
  const afterLoss = net - lossAmt;
  const feeTaken = min(closeFee + borrowFee, afterLoss);
  const shortfall = closeFee + borrowFee - feeTaken;
  const equity = afterLoss - feeTaken;
  const profitRaw = isProfit ? pnl : 0n;
  const profitAmt = shortfall <= profitRaw ? profitRaw - shortfall : 0n;
  return { isProfit, pnl, closeFee, borrowFee, lossAmt, feeTaken, shortfall, equity, profitAmt,
    payout: equity + profitAmt, fees: openFee + feeTaken, poolIn: lossAmt, poolOut: profitAmt };
}

/**
 * Proves closing `pos` (leaf `leafIndex` in `tree`), owned by `ownerSecret`.
 * The payout note goes to `payoutOwnerSecret` (default: the same owner).
 */
export async function proveClose({ tree, pos, leafIndex, ownerSecret, payoutOwnerSecret, exitPrice, closeTime, feeBps, maxPayout, treasuryOwner, borrowRate = 0 }) {
  const s = settle(pos, exitPrice, feeBps, maxPayout, { rate: borrowRate, time: closeTime });
  const payoutOwner = await ownerHashOf(payoutOwnerSecret ?? ownerSecret);
  const payoutSalt = randomScalar(248);
  const { pathElements, pathIndices } = tree.path(leafIndex);
  const input = {
    root: tree.root, exitPrice: BigInt(exitPrice), closeTime: BigInt(closeTime), feeBps: BigInt(feeBps),
    maxPayout: BigInt(maxPayout), treasuryOwner: BigInt(treasuryOwner), borrowRate: BigInt(borrowRate),
    isLong: pos.isLong ? 1n : 0n, size: BigInt(pos.size), collateral: BigInt(pos.collateral), entryPrice: BigInt(pos.entryPrice),
    openTime: BigInt(pos.openTime), openFee: BigInt(pos.openFee), ownerSecret: BigInt(ownerSecret), salt: BigInt(pos.salt),
    pathElements, pathIndices, pnl: s.pnl, closeFee: s.closeFee, borrowFee: s.borrowFee, payoutOwner, payoutSalt,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("close_position.wasm"), keys("close_position.zkey"));
  // [nullifier, payout, fee, poolIn, poolOut, root, exitPrice, closeTime, feeBps, maxPayout, treasuryOwner, borrowRate]
  const [nullifier, payout, fee, poolIn, poolOut] = publicSignals;
  const { poseidon, F } = await crypto();
  const feeSalt = F.toObject(poseidon([BigInt(pos.salt), 1n]));
  return {
    proof, publicSignals, settlement: s,
    soroban: { proof: proofToSoroban(proof), root: tree.root, nullifier, payout, fee, poolIn, poolOut },
    payoutNote: { amount: s.payout.toString(), salt: payoutSalt.toString(), inner: (await noteInner(payoutOwner, payoutSalt)).toString(),
      commitment: payout, expected: (await noteCommitment(s.payout, await noteInner(payoutOwner, payoutSalt))).toString() },
    feeNote: { amount: s.fees.toString(), salt: feeSalt.toString(), commitment: fee,
      expected: (await noteCommitment(s.fees, await noteInner(BigInt(treasuryOwner), feeSalt))).toString() },
  };
}
