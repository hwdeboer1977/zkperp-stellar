// Proving for shielded collateral: open from a note, withdraw a note.
import * as snarkjs from "snarkjs";
import { keyPath } from "./zkkeys.mjs";
import { crypto, randomScalar } from "./keeper.mjs";
import { ceilDiv } from "./open.mjs";
import { ownerHashOf, noteInner, noteCommitment } from "./notes.mjs";
import { proofToSoroban, hex32 } from "./encoding.mjs";

const keys = keyPath;

async function spendInputs(tree, note, ownerSecret) {
  const { pathElements, pathIndices } = tree.path(note.leafIndex);
  return { root: tree.root, noteAmount: BigInt(note.amount), ownerSecret: BigInt(ownerSecret), noteSalt: BigInt(note.salt), pathElements, pathIndices };
}

/**
 * Opens a position with `collateral` (gross) from `note`. Returns the proof,
 * public signals, Soroban-encoded args, the position record and the change note.
 */
export async function proveOpenPrivate({ tree, note, ownerSecret, isLong, size, collateral, entryPrice, openTime, feeBps, keeperPk }) {
  const salt = randomScalar(248), changeSalt = randomScalar(248);
  const openFee = ceilDiv(BigInt(size) * BigInt(feeBps), 10000n);
  const input = {
    ...(await spendInputs(tree, note, ownerSecret)),
    entryPrice: BigInt(entryPrice), openTime: BigInt(openTime), feeBps: BigInt(feeBps), keeperPk: keeperPk.map(BigInt),
    isLong: isLong ? 1n : 0n, size: BigInt(size), collateral: BigInt(collateral), openFee, salt, ephemeral: randomScalar(252), changeSalt,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("open_private.wasm"), keys("open_private.zkey"));
  // [nullifier, commitment, change, R.x, R.y, E0..E7, root, entryPrice, openTime, feeBps, pk.x, pk.y]
  const [nullifier, commitment, change, rx, ry, ...rest] = publicSignals;
  const ownerHash = await ownerHashOf(ownerSecret);
  const changeAmount = BigInt(note.amount) - BigInt(collateral);
  return {
    proof, publicSignals,
    soroban: { proof: proofToSoroban(proof), root: tree.root, nullifier, commitment, change, noteR: { x: rx, y: ry }, note: rest.slice(0, 8) },
    position: { isLong: !!isLong, size: input.size.toString(), collateral: (BigInt(collateral) - openFee).toString(), entryPrice: input.entryPrice.toString(),
      openTime: input.openTime.toString(), openFee: openFee.toString(), salt: salt.toString(), commitment, private: true },
    change: { amount: changeAmount.toString(), salt: changeSalt.toString(), inner: (await noteInner(ownerHash, changeSalt)).toString(),
      commitment: change, expected: (await noteCommitment(changeAmount, await noteInner(ownerHash, changeSalt))).toString() },
  };
}

/** Withdraws `amount` of `note` to the recipient field `recipient`; the rest is a change note. */
export async function proveWithdraw({ tree, note, ownerSecret, amount, recipient }) {
  const changeSalt = randomScalar(248);
  const input = { ...(await spendInputs(tree, note, ownerSecret)), amount: BigInt(amount), recipient: BigInt(recipient), changeSalt };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("withdraw_note.wasm"), keys("withdraw_note.zkey"));
  // [nullifier, change, root, amount, recipient]
  const [nullifier, change] = publicSignals;
  const ownerHash = await ownerHashOf(ownerSecret);
  return {
    proof, publicSignals, soroban: { proof: proofToSoroban(proof), root: tree.root, nullifier, change },
    change: { amount: (BigInt(note.amount) - BigInt(amount)).toString(), salt: changeSalt.toString(),
      inner: (await noteInner(ownerHash, changeSalt)).toString(), commitment: change },
  };
}

export async function verify(name, proof, publicSignals) {
  const vk = JSON.parse(await (await import("node:fs/promises")).readFile(keys(`${name}.vkey.json`), "utf8"));
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}

export { hex32 };

/** Merges notes `a` and `b` (same owner) into one with a new salt. */
export async function proveMerge({ tree, a, b, ownerSecret }) {
  const mergedSalt = randomScalar(248);
  const pa = tree.path(a.leafIndex), pb = tree.path(b.leafIndex);
  const input = { root: tree.root, ownerSecret: BigInt(ownerSecret),
    amountA: BigInt(a.amount), saltA: BigInt(a.salt), pathElementsA: pa.pathElements, pathIndicesA: pa.pathIndices,
    amountB: BigInt(b.amount), saltB: BigInt(b.salt), pathElementsB: pb.pathElements, pathIndicesB: pb.pathIndices, mergedSalt };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys("merge_notes.wasm"), keys("merge_notes.zkey"));
  const [nullifierA, nullifierB, merged] = publicSignals;
  const ownerHash = await ownerHashOf(ownerSecret);
  const amount = BigInt(a.amount) + BigInt(b.amount);
  return { proof, publicSignals, soroban: { proof: proofToSoroban(proof), root: tree.root, nullifierA, nullifierB, merged },
    merged: { amount: amount.toString(), salt: mergedSalt.toString(), inner: (await noteInner(ownerHash, mergedSalt)).toString(), commitment: merged } };
}
