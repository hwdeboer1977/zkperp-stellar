#![no_std]
//! Faucet for mUSDC, the mock stablecoin ZKPerp settles in on testnet.
//!
//! mUSDC is a classic Stellar asset with a Stellar Asset Contract (SAC), like
//! Circle's USDC, so ZKPerp talks to the same SEP-41 interface and the same 7
//! decimals either way. This contract is the SAC's admin and lets anyone mint.
//!
//! ⚠️ MOCK TOKEN. Anyone may mint any amount to any address. It exists so
//! testnet can hand out collateral without Circle's rate-limited faucet.

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, token, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidAmount = 1,
}

const SAC: Symbol = symbol_short!("SAC");

#[contract]
pub struct MusdcFaucet;

#[contractimpl]
impl MusdcFaucet {
    /// `sac` is the mUSDC Stellar Asset Contract. After deploying, the asset
    /// issuer must make this contract the SAC admin (`set_admin`).
    pub fn __constructor(env: Env, sac: Address) {
        env.storage().instance().set(&SAC, &sac);
    }

    /// Mints `amount` mUSDC (7 decimals: 1 mUSDC = 10_000_000) to `to`. A
    /// classic account (G...) needs an mUSDC trustline first; contracts don't.
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        token::StellarAssetClient::new(&env, &Self::sac(env.clone())).mint(&to, &amount);
        Ok(())
    }

    pub fn sac(env: Env) -> Address {
        env.storage().instance().get(&SAC).unwrap()
    }
}

mod test;
