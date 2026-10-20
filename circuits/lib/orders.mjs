// Trigger orders (steps 11-12): stop loss (kind 0) and take profit (kind 1).
//   orderId = Poseidon(position salt, kind, trigger, orderSalt)
//   order note (to keepers) = [leafIndex, kind, trigger, orderSalt]
import * as snarkjs from "snarkjs";
import { keyPath } from "./zkkeys.mjs";
import { crypto, randomScalar } from "./keeper.mjs";
import { settle } from "./close.mjs";
import { noteInner, noteCommitment } from "./notes.mjs";
import { proofToSoroban } from "./encoding.mjs";

const keys = keyPath;
export const ORDER_FIELDS = ["leafIndex", "kind", "trigger", "orderSalt"];
export const KIND = { sl: 0n, tp: 1n };
const isLongOf = (p) => p.isLong === true || p.isLong === 1n || p.isLong === "1";

export async function orderIdOf(salt, kind, trigger, orderSalt) {
  const { poseidon, F } = await crypto();
  return F.toObject(poseidon([BigInt(salt), BigInt(kind), BigInt(trigger), BigInt(orderSalt)]));
}

/** Whether the order fires at `exit`: long SL / short TP at exit <= trigger, short SL / long TP at exit >= trigger. */
export function fires(pos, kind, trigger, exit) {
  const below = isLongOf(pos) !== (BigInt(kind) === 1n); // isLong XOR kind
  return below ? BigInt(exit) <= BigInt(trigger) : BigInt(exit) >= BigInt(trigger);
}

function positionInputs(pos) {
  return { isLong: isLongOf(pos) ? 1n : 0n, size: BigInt(pos.size), collateral: BigInt(pos.collateral), entryPrice: BigInt(pos.entryPrice),
    openTime: BigInt(pos.openTime), openFee: BigInt(pos.openFee), salt: BigInt(pos.salt) };
}

/** Place (action 1) or cancel (action 2) an order on the owner's position. */
export async function proveOrderAuth({ tree, pos, leafIndex, ownerSecret, kind, trigger, orderSalt, action, keeperPk }) {
  const { pathElements, pathIndices } = tree.path(leafIndex);
  const input = { root: tree.root, action: BigInt(action), keeperPk: keeperPk.map(BigInt), ...positionInputs(pos), ownerSecret: BigInt(ownerSecret),
    pathElements, pathIndices, kind: BigInt(kind), trigger: BigInt(trigger), orderSalt: BigInt(orderSalt), ephemeral: randomScalar(252) };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("order_auth.wasm"), keys("order_auth.zkey"));
  // [orderId, R.x, R.y, E0..E3, root, action, pk.x, pk.y]
  const [orderId, rx, ry, ...rest] = publicSignals;
  return { proof, publicSignals, soroban: { proof: proofToSoroban(proof), root: tree.root, orderId, noteR: { x: rx, y: ry }, note: rest.slice(0, 4) } };
}

/** The keeper executes an order (position fields from the keeper note, incl. ownerHash). */
export async function proveExecuteOrder({ tree, pos, leafIndex, kind, trigger, orderSalt, exitPrice, closeTime, feeBps, maxPayout, treasuryOwner, borrowRate = 0 }) {
  const s = settle(pos, exitPrice, feeBps, maxPayout, { rate: borrowRate, time: closeTime });
  const { pathElements, pathIndices } = tree.path(leafIndex);
  const orderId = await orderIdOf(pos.salt, kind, trigger, orderSalt);
  const input = { root: tree.root, exitPrice: BigInt(exitPrice), closeTime: BigInt(closeTime), feeBps: BigInt(feeBps), maxPayout: BigInt(maxPayout),
    treasuryOwner: BigInt(treasuryOwner), borrowRate: BigInt(borrowRate), orderId, ...positionInputs(pos), ownerHash: BigInt(pos.ownerHash),
    kind: BigInt(kind), trigger: BigInt(trigger), orderSalt: BigInt(orderSalt), pathElements, pathIndices,
    pnl: s.pnl, closeFee: s.closeFee, borrowFee: s.borrowFee };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("execute_order.wasm"), keys("execute_order.zkey"));
  const [nullifier, payout, fee, poolIn, poolOut] = publicSignals;
  return { proof, publicSignals, settlement: s, orderId,
    soroban: { proof: proofToSoroban(proof), root: tree.root, orderId: orderId.toString(), nullifier, payout, fee, poolIn, poolOut },
    payoutNote: await orderPayoutNote(pos, s.payout) };
}

/** The owner's payout note after an executed order (salt Poseidon(salt, 3)). */
export async function orderPayoutNote(pos, amount) {
  const { poseidon, F } = await crypto();
  const salt = F.toObject(poseidon([BigInt(pos.salt), 3n]));
  const inner = await noteInner(BigInt(pos.ownerHash), salt);
  return { amount: amount.toString(), salt: salt.toString(), inner: inner.toString(), commitment: (await noteCommitment(amount, inner)).toString() };
}

export const newOrderSalt = () => randomScalar(248);
