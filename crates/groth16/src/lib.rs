#![no_std]
//! Groth16 verification on BN254 (alt_bn128) using Soroban's native host
//! functions (CAP-0074, CAP-0080 MSM). Point encodings are
//! Ethereum-compatible, so verification keys / proofs from circom+snarkjs or
//! arkworks work as-is. Library only; `contracts/zk-verifier` wraps it.

use soroban_sdk::{
    contracterror, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    vec, BytesN, Env, Vec, U256,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    MalformedVerifyingKey = 3,
    WrongPublicInputCount = 4,
}

/// Groth16 verification key. G1 = 64 bytes (X||Y), G2 = 128 bytes
/// (X.c1||X.c0||Y.c1||Y.c0), all big-endian.
#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: BytesN<64>,
    pub beta: BytesN<128>,
    pub gamma: BytesN<128>,
    pub delta: BytesN<128>,
    /// ic[0] + sum(ic[i+1] * public_input[i])
    pub ic: Vec<BytesN<64>>,
}

#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

pub fn verify_groth16(
    env: &Env,
    vk: &VerificationKey,
    proof: &Proof,
    public_inputs: &Vec<U256>,
) -> Result<bool, Error> {
    if public_inputs.len() + 1 != vk.ic.len() {
        return Err(Error::WrongPublicInputCount);
    }
    let bn = env.crypto().bn254();

    // vk_x = 1*ic[0] + sum(input[i] * ic[i+1]), as a single MSM host call
    let mut points = Vec::new(env);
    let mut scalars = Vec::new(env);
    for ic in vk.ic.iter() {
        points.push_back(Bn254G1Affine::from_bytes(ic));
    }
    scalars.push_back(Bn254Fr::from_u256(U256::from_u32(env, 1)));
    for input in public_inputs.iter() {
        scalars.push_back(Bn254Fr::from_u256(input));
    }
    let vk_x = bn.g1_msm(points, scalars);

    // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    let neg_a = -Bn254G1Affine::from_bytes(proof.a.clone());
    let g1 = vec![
        env,
        neg_a,
        Bn254G1Affine::from_bytes(vk.alpha.clone()),
        vk_x,
        Bn254G1Affine::from_bytes(proof.c.clone()),
    ];
    let g2 = vec![
        env,
        Bn254G2Affine::from_bytes(proof.b.clone()),
        Bn254G2Affine::from_bytes(vk.beta.clone()),
        Bn254G2Affine::from_bytes(vk.gamma.clone()),
        Bn254G2Affine::from_bytes(vk.delta.clone()),
    ];
    Ok(bn.pairing_check(g1, g2))
}
