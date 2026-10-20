// Liquidation: the settlement maths (mirrors liquidate_position.circom) and
// the keeper's prover. The keeper identifies the position by owner HASH, from
// the keeper note; it never has the owner secret.
import * as snarkjs from "snarkjs";
import { keyPath } from "./zkkeys.mjs";
import { crypto } from "./keeper.mjs";
import { ceilDiv } from "./open.mjs";
import { borrowFeeOf } from "./close.mjs";
import { noteInner, noteCommitment } from "./notes.mjs";
import { proofToSoroban } from "./encoding.mjs";

const keys = keyPath;
const min = (a, b) => (a < b ? a : b);

/** Liquidation settlement of `pos` at `exitPrice`; `liquidatable` says whether it's allowed. */
export function settleLiquidation(pos, exitPrice, feeBps, maintenanceBps, liqFeeBps, borrow = {}) {
  const size = BigInt(pos.size), entry = BigInt(pos.entryPrice), net = BigInt(pos.collateral), exit = BigInt(exitPrice);
  const isLong = pos.isLong === true || pos.isLong === 1n || pos.isLong === "1";
  const rose = entry <= exit, fell = exit <= entry;
  const isProfit = isLong ? rose : fell;
  const delta = size * (rose ? exit - entry : entry - exit);
  const pnl = isProfit ? 0n : ceilDiv(delta, entry);
  const closeFee = ceilDiv(size * BigInt(feeBps), 10000n);
  const liqFee = ceilDiv(size * BigInt(liqFeeBps), 10000n);
  const borrowFee = borrowFeeOf(pos, borrow.rate, borrow.time);
  const lossAmt = isProfit ? 0n : min(pnl, net);
  const afterLoss = net - lossAmt;
  const feeTaken = min(closeFee + borrowFee, afterLoss);
  const equity = afterLoss - feeTaken;
  const liqTaken = min(liqFee, equity);
  const back = equity - liqTaken;
  // A position in profit (delta > 0) can't be liquidated; flat or a loss can, if below maintenance.
  const liquidatable = !(isProfit && delta > 0n) && equity * 10000n < size * BigInt(maintenanceBps);
  return { isProfit, pnl, closeFee, borrowFee, liqFee, lossAmt, feeTaken, equity, liqTaken, back,
    fees: BigInt(pos.openFee) + feeTaken + liqTaken, poolIn: lossAmt, liquidatable };
}

/** The owner's payout note after a liquidation (the owner can recompute it from the salt). */
export async function liquidationPayoutNote(pos, back) {
  const { poseidon, F } = await crypto();
  const salt = F.toObject(poseidon([BigInt(pos.salt), 2n]));
  const inner = await noteInner(BigInt(pos.ownerHash), salt);
  return { amount: back.toString(), salt: salt.toString(), inner: inner.toString(), commitment: (await noteCommitment(back, inner)).toString() };
}

/** Proves liquidating `pos` (fields from the keeper note) at leaf `leafIndex`. */
export async function proveLiquidation({ tree, pos, leafIndex, exitPrice, liqTime, feeBps, treasuryOwner, maintenanceBps, liqFeeBps, borrowRate = 0 }) {
  const s = settleLiquidation(pos, exitPrice, feeBps, maintenanceBps, liqFeeBps, { rate: borrowRate, time: liqTime });
  const { pathElements, pathIndices } = tree.path(leafIndex);
  const isLong = pos.isLong === true || pos.isLong === 1n || pos.isLong === "1";
  const input = {
    root: tree.root, exitPrice: BigInt(exitPrice), liqTime: BigInt(liqTime), feeBps: BigInt(feeBps), treasuryOwner: BigInt(treasuryOwner),
    maintenanceBps: BigInt(maintenanceBps), liqFeeBps: BigInt(liqFeeBps), borrowRate: BigInt(borrowRate),
    isLong: isLong ? 1n : 0n, size: BigInt(pos.size), collateral: BigInt(pos.collateral), entryPrice: BigInt(pos.entryPrice),
    openTime: BigInt(pos.openTime), openFee: BigInt(pos.openFee), ownerHash: BigInt(pos.ownerHash), salt: BigInt(pos.salt),
    pathElements, pathIndices, pnl: s.pnl, closeFee: s.closeFee, liqFee: s.liqFee, borrowFee: s.borrowFee,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("liquidate_position.wasm"), keys("liquidate_position.zkey"));
  // [nullifier, payout, fee, poolIn, root, exitPrice, liqTime, feeBps, treasuryOwner, maintenanceBps, liqFeeBps, borrowRate]
  const [nullifier, payout, fee, poolIn] = publicSignals;
  return { proof, publicSignals, settlement: s, soroban: { proof: proofToSoroban(proof), root: tree.root, nullifier, payout, fee, poolIn },
    payoutNote: await liquidationPayoutNote(pos, s.back) };
}
