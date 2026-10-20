#![no_std]
//! circomlib-compatible Poseidon over BN254, on Soroban's native
//! `poseidon_permutation` host function (CAP-0075).
//!
//! The host function takes every parameter from the caller, so these must
//! match circomlib exactly: t = inputs + 1, x^5 S-box, 8 full rounds, partial
//! rounds per t, constants from circomlibjs (`constants.rs`, generated).
//! Hash = permutation([0, inputs...])[0].
//!
//! Library only; `contracts/poseidon` wraps it as a contract for testing.

use soroban_sdk::{contracterror, symbol_short, Bytes, Env, Vec, U256};

pub mod constants;
pub use constants::{TREE_DEPTH, ZEROS};
use constants::*;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    UnsupportedWidth = 1,
    InputNotInField = 2,
}

const ROUNDS_F: u32 = 8;
const SBOX_DEGREE: u32 = 5;

/// BN254 scalar field modulus r, big-endian.
pub const R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub fn u256(env: &Env, be: &[u8; 32]) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, be))
}

/// True if `x` is a canonical BN254 scalar field element (`x < r`).
pub fn in_field(env: &Env, x: &U256) -> bool {
    *x < u256(env, &R)
}

/// Poseidon parameters for one width, converted to host values once and
/// reused for many hashes (a Merkle insertion hashes 20 times).
pub struct Params {
    t: u32,
    rounds_p: u32,
    mds: Vec<Vec<U256>>,
    rc: Vec<Vec<U256>>,
}

impl Params {
    pub fn new(env: &Env, rounds_p: u32, c: &[[u8; 32]], m: &[impl AsRef<[[u8; 32]]>]) -> Self {
        let t = m.len() as u32;
        let mut mds = Vec::new(env);
        for row in m {
            let mut r = Vec::new(env);
            for x in row.as_ref() {
                r.push_back(u256(env, x));
            }
            mds.push_back(r);
        }
        let mut rc = Vec::new(env);
        for round in c.chunks(t as usize) {
            let mut r = Vec::new(env);
            for x in round {
                r.push_back(u256(env, x));
            }
            rc.push_back(r);
        }
        Params { t, rounds_p, mds, rc }
    }

    pub fn t2(env: &Env) -> Self {
        Self::new(env, ROUNDS_P_T2, &C_T2, &M_T2)
    }

    pub fn t3(env: &Env) -> Self {
        Self::new(env, ROUNDS_P_T3, &C_T3, &M_T3)
    }

    pub fn t5(env: &Env) -> Self {
        Self::new(env, ROUNDS_P_T5, &C_T5, &M_T5)
    }

    /// Hashes `t - 1` inputs. Callers must ensure inputs are `< r`.
    pub fn hash(&self, env: &Env, inputs: &[U256]) -> U256 {
        let mut state = Vec::new(env);
        state.push_back(U256::from_u32(env, 0));
        for x in inputs {
            state.push_back(x.clone());
        }
        assert_eq!(state.len(), self.t);
        env.crypto_hazmat()
            .poseidon_permutation(
                &state,
                symbol_short!("BN254"),
                self.t,
                SBOX_DEGREE,
                ROUNDS_F,
                self.rounds_p,
                &self.mds,
                &self.rc,
            )
            .get_unchecked(0)
    }
}

/// circomlib `Poseidon(n)` for n = 1, 2 or 4 inputs. Rejects inputs >= r,
/// because the host function would silently reduce them.
pub fn poseidon(env: &Env, inputs: &Vec<U256>) -> Result<U256, Error> {
    let mut xs = [U256::from_u32(env, 0), U256::from_u32(env, 0), U256::from_u32(env, 0), U256::from_u32(env, 0)];
    for (i, x) in inputs.iter().enumerate() {
        if !in_field(env, &x) {
            return Err(Error::InputNotInField);
        }
        if i < 4 {
            xs[i] = x;
        }
    }
    let n = inputs.len() as usize;
    Ok(match n {
        1 => Params::t2(env).hash(env, &xs[..1]),
        2 => Params::t3(env).hash(env, &xs[..2]),
        4 => Params::t5(env).hash(env, &xs[..4]),
        _ => return Err(Error::UnsupportedWidth),
    })
}
