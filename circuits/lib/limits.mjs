// Limit orders (step 13).
//   order = Poseidon(isLong, size, collateral, limit, ownerHash, orderSalt)
//   keeper note = [isLong, size, collateral, limit, ownerHash, orderSalt]
//   filled position salt = Poseidon(orderSalt, 4); refund note salt = Poseidon(orderSalt, 5)
import * as snarkjs from "snarkjs";
import { keyPath } from "./zkkeys.mjs";
import { crypto, randomScalar } from "./keeper.mjs";
import { ceilDiv } from "./open.mjs";
import { ownerHashOf, noteInner, noteCommitment } from "./notes.mjs";
import { proofToSoroban } from "./encoding.mjs";

const keys = keyPath;
export const LIMIT_FIELDS = ["isLong", "size", "collateral", "limitPrice", "ownerHash", "orderSalt"];
const isLongOf = (o) => o.isLong === true || o.isLong === 1n || o.isLong === "1";

export async function limitCommitment(o) {
  const { poseidon, F } = await crypto();
  return F.toObject(poseidon([isLongOf(o) ? 1n : 0n, o.size, o.collateral, o.limitPrice, o.ownerHash, o.orderSalt].map(BigInt)));
}

/** Whether the order fills at `mark`: long at mark <= limit, short at mark >= limit. */
export const reached = (o, mark) => (isLongOf(o) ? BigInt(mark) <= BigInt(o.limitPrice) : BigInt(mark) >= BigInt(o.limitPrice));

/** The position a filled order opens (what owner and keepers rebuild). */
export async function filledPosition(o, entryPrice, openTime, feeBps) {
  const { poseidon, F } = await crypto();
  const openFee = ceilDiv(BigInt(o.size) * BigInt(feeBps), 10000n);
  const pos = { isLong: isLongOf(o), size: BigInt(o.size), collateral: BigInt(o.collateral) - openFee, entryPrice: BigInt(entryPrice),
    openTime: BigInt(openTime), openFee, ownerHash: BigInt(o.ownerHash), salt: F.toObject(poseidon([BigInt(o.orderSalt), 4n])) };
  pos.commitment = F.toObject(poseidon([pos.isLong ? 1n : 0n, pos.size, pos.collateral, pos.entryPrice, pos.openTime, pos.openFee, pos.ownerHash, pos.salt]));
  return pos;
}

export async function refundNote(o) {
  const { poseidon, F } = await crypto();
  const salt = F.toObject(poseidon([BigInt(o.orderSalt), 5n]));
  const inner = await noteInner(BigInt(o.ownerHash), salt);
  return { amount: BigInt(o.collateral).toString(), salt: salt.toString(), inner: inner.toString(), commitment: (await noteCommitment(BigInt(o.collateral), inner)).toString() };
}

/** Escrows `collateral` from `note` into a limit order. */
export async function provePlaceLimit({ tree, note, ownerSecret, isLong, size, collateral, limitPrice, keeperPk }) {
  const orderSalt = randomScalar(248), changeSalt = randomScalar(248);
  const { pathElements, pathIndices } = tree.path(note.leafIndex);
  const input = { root: tree.root, keeperPk: keeperPk.map(BigInt), noteAmount: BigInt(note.amount), ownerSecret: BigInt(ownerSecret), noteSalt: BigInt(note.salt),
    pathElements, pathIndices, changeSalt, isLong: isLong ? 1n : 0n, size: BigInt(size), collateral: BigInt(collateral), limitPrice: BigInt(limitPrice),
    orderSalt, ephemeral: randomScalar(252) };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("place_limit.wasm"), keys("place_limit.zkey"));
  // [nullifier, order, change, R.x, R.y, E0..E5, root, pk.x, pk.y]
  const [nullifier, order, change, rx, ry, ...rest] = publicSignals;
  const ownerHash = await ownerHashOf(ownerSecret);
  return { proof, publicSignals,
    soroban: { proof: proofToSoroban(proof), root: tree.root, nullifier, order, change, noteR: { x: rx, y: ry }, note: rest.slice(0, 6) },
    order: { isLong: !!isLong, size: BigInt(size).toString(), collateral: BigInt(collateral).toString(), limitPrice: BigInt(limitPrice).toString(),
      ownerHash: ownerHash.toString(), orderSalt: orderSalt.toString(), order },
    change: { amount: (BigInt(note.amount) - BigInt(collateral)).toString(), salt: changeSalt.toString(),
      inner: (await noteInner(ownerHash, changeSalt)).toString(), commitment: change } };
}

/** The keeper fills `o` (fields from the keeper note) at the mark price. */
export async function proveExecuteLimit({ o, entryPrice, openTime, feeBps }) {
  const pos = await filledPosition(o, entryPrice, openTime, feeBps);
  const input = { order: await limitCommitment(o), entryPrice: BigInt(entryPrice), openTime: BigInt(openTime), feeBps: BigInt(feeBps),
    isLong: isLongOf(o) ? 1n : 0n, size: BigInt(o.size), collateral: BigInt(o.collateral), limitPrice: BigInt(o.limitPrice),
    ownerHash: BigInt(o.ownerHash), orderSalt: BigInt(o.orderSalt), openFee: pos.openFee };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("execute_limit.wasm"), keys("execute_limit.zkey"));
  return { proof, publicSignals, position: pos, soroban: { proof: proofToSoroban(proof), order: input.order.toString(), commitment: publicSignals[0] } };
}

/** The owner cancels `o` and gets the collateral back as a note. */
export async function proveCancelLimit({ o, ownerSecret }) {
  const input = { order: await limitCommitment(o), isLong: isLongOf(o) ? 1n : 0n, size: BigInt(o.size), collateral: BigInt(o.collateral),
    limitPrice: BigInt(o.limitPrice), ownerSecret: BigInt(ownerSecret), orderSalt: BigInt(o.orderSalt) };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("cancel_limit.wasm"), keys("cancel_limit.zkey"));
  return { proof, publicSignals, soroban: { proof: proofToSoroban(proof), order: input.order.toString(), refund: publicSignals[0] }, refund: await refundNote(o) };
}
