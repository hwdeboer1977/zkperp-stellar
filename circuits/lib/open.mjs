// Builds and proves an open_position witness.
import * as snarkjs from "snarkjs";
import { keyPath } from "./zkkeys.mjs";
import { crypto, randomScalar } from "./keeper.mjs";
import { proofToSoroban, hex32 } from "./encoding.mjs";

const keys = keyPath;

export const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Opens a position. `collateral` is the gross amount transferred (token units),
 * `size` the notional. Returns the proof, public signals and the private
 * position record the trader must keep (salt and ownerSecret).
 */
export async function proveOpen({ isLong, size, collateral, entryPrice, openTime, feeBps, keeperPk, ownerSecret }) {
  const { poseidon, F } = await crypto();
  ownerSecret ??= randomScalar(248);
  const salt = randomScalar(248);
  const openFee = ceilDiv(BigInt(size) * BigInt(feeBps), 10000n);
  const input = {
    collateral: BigInt(collateral), entryPrice: BigInt(entryPrice), openTime: BigInt(openTime),
    feeBps: BigInt(feeBps), keeperPk: keeperPk.map(BigInt),
    isLong: isLong ? 1n : 0n, size: BigInt(size), openFee,
    ownerHash: F.toObject(poseidon([ownerSecret])), salt, ephemeral: randomScalar(252),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input, keys("open_position.wasm"), keys("open_position.zkey"));
  // publicSignals: [commitment, R.x, R.y, E0..E7, collateral, entryPrice, openTime, feeBps, pk.x, pk.y]
  const [commitment, rx, ry, ...rest] = publicSignals;
  return {
    proof, publicSignals,
    soroban: { proof: proofToSoroban(proof), commitment: hex32(commitment), noteR: [hex32(rx), hex32(ry)], note: rest.slice(0, 8).map(hex32) },
    position: {
      isLong: !!isLong, size: input.size.toString(), collateral: (input.collateral - openFee).toString(),
      entryPrice: input.entryPrice.toString(), openTime: input.openTime.toString(), openFee: openFee.toString(),
      ownerSecret: ownerSecret.toString(), salt: salt.toString(), commitment,
    },
  };
}

export async function verifyOpen(proof, publicSignals) {
  const vk = JSON.parse(await (await import("node:fs/promises")).readFile(keys("open_position.vkey.json"), "utf8"));
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}
