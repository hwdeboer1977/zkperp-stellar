#![cfg(test)]
//! Generates a real Groth16 proof off-chain with arkworks and verifies it
//! inside the Soroban host (same metering as on-chain).
//!
//! Circuit: prover knows private `a`, `b` such that
//!   a * b == product   (public)
//!   a + b == sum       (public)

extern crate std;

use super::*;
use ark_bn254::{Bn254, Fq, Fq2, Fr as ArkFr, G1Affine, G2Affine};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_relations::{
    lc,
    r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError, Variable},
};
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};
use soroban_sdk::{Bytes, BytesN, Env};

#[derive(Clone)]
struct FactorCircuit {
    a: Option<ArkFr>,
    b: Option<ArkFr>,
}

impl ConstraintSynthesizer<ArkFr> for FactorCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<ArkFr>) -> Result<(), SynthesisError> {
        let a_val = self.a;
        let b_val = self.b;
        let a = cs.new_witness_variable(|| a_val.ok_or(SynthesisError::AssignmentMissing))?;
        let b = cs.new_witness_variable(|| b_val.ok_or(SynthesisError::AssignmentMissing))?;
        let product = cs.new_input_variable(|| {
            Ok(a_val.ok_or(SynthesisError::AssignmentMissing)?
                * b_val.ok_or(SynthesisError::AssignmentMissing)?)
        })?;
        let sum = cs.new_input_variable(|| {
            Ok(a_val.ok_or(SynthesisError::AssignmentMissing)?
                + b_val.ok_or(SynthesisError::AssignmentMissing)?)
        })?;
        cs.enforce_constraint(lc!() + a, lc!() + b, lc!() + product)?;
        cs.enforce_constraint(
            lc!() + a + b,
            lc!() + Variable::One,
            lc!() + sum,
        )?;
        Ok(())
    }
}

// ---- arkworks -> Soroban (Ethereum-compatible) encoding ----

fn fq_be(x: &Fq) -> std::vec::Vec<u8> {
    x.into_bigint().to_bytes_be()
}

fn g1(env: &Env, p: &G1Affine) -> BytesN<64> {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&fq_be(&p.x));
    out[32..].copy_from_slice(&fq_be(&p.y));
    BytesN::from_array(env, &out)
}

fn fq2_be(x: &Fq2) -> std::vec::Vec<u8> {
    [fq_be(&x.c1), fq_be(&x.c0)].concat()
}

fn g2(env: &Env, p: &G2Affine) -> BytesN<128> {
    let mut out = [0u8; 128];
    out[..64].copy_from_slice(&fq2_be(&p.x));
    out[64..].copy_from_slice(&fq2_be(&p.y));
    BytesN::from_array(env, &out)
}

fn fr(env: &Env, x: ArkFr) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_slice(env, &x.into_bigint().to_bytes_be()))
}

struct Fixture {
    vk: VerificationKey,
    proof: Proof,
    inputs: Vec<U256>,
}

fn setup(env: &Env) -> Fixture {
    let mut rng = StdRng::seed_from_u64(42);
    let (a, b) = (ArkFr::from(3u64), ArkFr::from(11u64));
    let circuit = FactorCircuit { a: Some(a), b: Some(b) };

    let (pk, ark_vk) = Groth16::<Bn254>::circuit_specific_setup(circuit.clone(), &mut rng).unwrap();
    let ark_proof = Groth16::<Bn254>::prove(&pk, circuit, &mut rng).unwrap();
    let public = [a * b, a + b];
    // sanity check off-chain first
    assert!(Groth16::<Bn254>::verify(&ark_vk, &public, &ark_proof).unwrap());

    let mut ic = Vec::new(env);
    for p in &ark_vk.gamma_abc_g1 {
        ic.push_back(g1(env, p));
    }
    Fixture {
        vk: VerificationKey {
            alpha: g1(env, &ark_vk.alpha_g1),
            beta: g2(env, &ark_vk.beta_g2),
            gamma: g2(env, &ark_vk.gamma_g2),
            delta: g2(env, &ark_vk.delta_g2),
            ic,
        },
        proof: Proof {
            a: g1(env, &ark_proof.a),
            b: g2(env, &ark_proof.b),
            c: g1(env, &ark_proof.c),
        },
        inputs: soroban_sdk::vec![env, fr(env, public[0]), fr(env, public[1])],
    }
}

fn deploy(env: &Env, vk: &VerificationKey) -> ZkVerifierClient<'static> {
    let id = env.register(ZkVerifier, ());
    let client = ZkVerifierClient::new(env, &id);
    client.init(vk);
    client
}

#[test]
fn valid_proof_verifies() {
    let env = Env::default();
    let f = setup(&env);
    let client = deploy(&env, &f.vk);

    env.cost_estimate().budget().reset_default();
    assert!(client.verify(&f.proof, &f.inputs));
    let budget = env.cost_estimate().budget();
    std::println!(
        "groth16 verify: cpu_insns={} mem_bytes={} (native; see wasm_verify_cost for on-chain cost)",
        budget.cpu_instruction_cost(),
        budget.memory_bytes_cost()
    );
}

#[test]
fn wrong_public_input_rejected() {
    let env = Env::default();
    let f = setup(&env);
    let client = deploy(&env, &f.vk);
    // claim product 34 instead of 33
    let bad = soroban_sdk::vec![&env, fr(&env, ArkFr::from(34u64)), f.inputs.get(1).unwrap()];
    assert!(!client.verify(&f.proof, &bad));
}

#[test]
fn tampered_proof_rejected() {
    let env = Env::default();
    let f = setup(&env);
    let client = deploy(&env, &f.vk);
    // swap A and C (both valid curve points, wrong proof)
    let bad = Proof { a: f.proof.c.clone(), b: f.proof.b.clone(), c: f.proof.a.clone() };
    assert!(!client.verify(&bad, &f.inputs));
}

#[test]
fn wrong_input_count_errors() {
    let env = Env::default();
    let f = setup(&env);
    let client = deploy(&env, &f.vk);
    let res = client.try_verify(&f.proof, &soroban_sdk::vec![&env, f.inputs.get(0).unwrap()]);
    assert_eq!(res, Err(Ok(Error::WrongPublicInputCount)));
}

/// Measures `verify` running as the real compiled WASM (native tests
/// under-count). Build first with `stellar contract build`; skipped if the
/// .wasm is missing. Override the path with ZK_VERIFIER_WASM.
#[test]
fn wasm_verify_cost() {
    let path = std::env::var("ZK_VERIFIER_WASM").unwrap_or_else(|_| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/wasm32v1-none/release/zk_verifier.wasm")
            .into()
    });
    let Ok(wasm) = std::fs::read(&path) else {
        std::println!("skipping wasm_verify_cost: {path} not found");
        return;
    };

    for n_inputs in [2u32, 19] {
        let env = Env::default();
        let f = setup(&env);
        // Pad the VK/inputs to n_inputs. The pairing check then fails, but
        // the work done (MSM + 4-pair pairing) is the same as for a valid proof.
        let mut vk = f.vk.clone();
        let mut inputs = f.inputs.clone();
        while inputs.len() < n_inputs {
            let i = inputs.len();
            vk.ic.push_back(vk.ic.get(i % 3).unwrap());
            inputs.push_back(fr(&env, -ArkFr::from(i as u64 + 1))); // full-width scalar
        }

        let id = env.register(wasm.as_slice(), ());
        let client = ZkVerifierClient::new(&env, &id);
        client.init(&vk);
        env.cost_estimate().budget().reset_unlimited();
        let ok = client.verify(&f.proof, &inputs);
        assert_eq!(ok, n_inputs == 2);
        let cpu = env.cost_estimate().budget().cpu_instruction_cost();
        std::println!(
            "wasm verify, {n_inputs} public inputs: cpu_insns={cpu} ({:.1}% of 400M tx limit)",
            cpu as f64 / 4e6
        );
    }
}
