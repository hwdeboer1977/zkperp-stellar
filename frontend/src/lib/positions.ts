// Display maths for positions (the settlement itself is the shared ZK code).
import type { VaultState } from "./hooks";
import type { PositionRec } from "./store";
import * as zk from "./zk";

export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Approximate liquidation price: equity (after the closing fee) falls below maintenance. */
export function liqPrice(p: { isLong: boolean; size: bigint; collateral: bigint; entryPrice: bigint }, feeBps: number, maintBps: number) {
  const closeFee = ceilDiv(p.size * BigInt(feeBps), 10_000n);
  const room = p.collateral - closeFee - (p.size * BigInt(maintBps)) / 10_000n;
  if (room <= 0n) return p.entryPrice;
  const move = (p.entryPrice * room) / p.size;
  return p.isLong ? p.entryPrice - move : p.entryPrice + move;
}

/** What closing now would do (PnL, fees, payout), with the borrow fee accrued so far. */
export function closeNow(p: PositionRec, s: VaultState) {
  if (!s.mark) return null;
  return zk.settle(p, s.mark.price, s.config.fee_bps, s.maxPayout, { rate: s.borrowRate, time: BigInt(Math.floor(Date.now() / 1000)) }) as {
    isProfit: boolean; pnl: bigint; payout: bigint; fees: bigint; closeFee: bigint; borrowFee: bigint; poolOut: bigint;
  };
}

/** Position size from collateral and leverage, the opening fee included: size = lev*net, net = coll - size*fee. */
export function sizeFor(collateral: bigint, leverage: number, feeBps: number) {
  const lev = BigInt(Math.round(leverage * 100));
  return (collateral * lev * 10_000n) / (100n * 10_000n + lev * BigInt(feeBps));
}
