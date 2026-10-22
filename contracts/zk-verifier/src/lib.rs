#![no_std]
//! Groth16 verifier contract (`init(vk)`, `verify(proof, public_inputs)`)
//! around the `groth16` library.

pub use groth16::*;
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol, Vec, U256};

const VK: Symbol = symbol_short!("VK");

#[contract]
pub struct ZkVerifier;

#[contractimpl]
impl ZkVerifier {
    /// Store the verification key for the circuit this contract checks.
    pub fn init(env: Env, vk: VerificationKey) -> Result<(), Error> {
        if env.storage().instance().has(&VK) {
            return Err(Error::AlreadyInitialized);
        }
        if vk.ic.is_empty() {
            return Err(Error::MalformedVerifyingKey);
        }
        env.storage().instance().set(&VK, &vk);
        Ok(())
    }

    /// Verify a proof against the stored key. Public inputs are BN254 scalar
    /// field elements as U256.
    pub fn verify(env: Env, proof: Proof, public_inputs: Vec<U256>) -> Result<bool, Error> {
        let vk: VerificationKey = env
            .storage()
            .instance()
            .get(&VK)
            .ok_or(Error::NotInitialized)?;
        Ok(verify_groth16(&env, &vk, &proof, &public_inputs)?)
    }
}

mod test;
