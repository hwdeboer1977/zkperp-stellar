#![no_std]
//! Contract wrapper around `zkperp-poseidon`, used to test the host-function
//! Poseidon against circomlibjs vectors and measure its cost.

use soroban_sdk::{contract, contractimpl, Env, Vec, U256};
pub use zkperp_poseidon::*;

#[contract]
pub struct PoseidonHasher;

#[contractimpl]
impl PoseidonHasher {
    pub fn hash(env: Env, inputs: Vec<U256>) -> Result<U256, Error> {
        poseidon(&env, &inputs)
    }
}

mod test;
