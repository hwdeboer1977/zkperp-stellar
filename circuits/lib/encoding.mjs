// snarkjs (bn128) objects -> the Soroban verifier's byte encoding:
// G1 = X||Y (64 bytes), G2 = X.c1||X.c0||Y.c1||Y.c0 (128 bytes), big-endian.
// snarkjs stores G2 coordinates as [c0, c1].

export const hex32 = (x) => BigInt(x).toString(16).padStart(64, "0");
export const g1 = (p) => hex32(p[0]) + hex32(p[1]);
export const g2 = (p) => hex32(p[0][1]) + hex32(p[0][0]) + hex32(p[1][1]) + hex32(p[1][0]);

export const proofToSoroban = (proof) => ({ a: g1(proof.pi_a), b: g2(proof.pi_b), c: g1(proof.pi_c) });

export const vkeyToSoroban = (vk) => ({
  alpha: g1(vk.vk_alpha_1),
  beta: g2(vk.vk_beta_2),
  gamma: g2(vk.vk_gamma_2),
  delta: g2(vk.vk_delta_2),
  ic: vk.IC.map(g1),
});
