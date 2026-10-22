//! The mark price: a Chainlink round signed by 2 of 3 oracle signers.
//! Soroban counterpart of `setPrice` / `rotateSigner` in zkperp-midnight.
//!
//! Each signer is an ed25519 key (a Stellar account key), verified natively.
//! A signer signs `sha256(xdr(("zkp_price", vault, round, price, updated_at)))`
//! for a Chainlink round it read itself. Anyone may submit two signatures; the
//! signatures are the authority, not the submitter. The vault's address is in
//! the message, so a report can't be replayed on another vault or network.
//!
//! Rounds only move forward, the price time may not be in the future or older
//! than the current one, and opens refuse a price older than `max_price_age`,
//! measured from the round's `updated_at` (when the price was observed, not
//! when it was submitted).

use crate::{DataKey, Error, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient};
use soroban_sdk::{contractevent, contractimpl, contracttype, symbol_short, xdr::ToXdr, BytesN, Env, Vec};

pub const SIGNERS: u32 = 3;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkPrice {
    /// Token units per unit of the base asset, 7 decimals.
    pub price: i128,
    /// The round's `updated_at` (unix seconds): when the price was observed.
    pub time: u64,
    /// Chainlink round id (phase << 64 | aggregator round).
    pub round: u128,
    /// The two signer slots that signed it.
    pub signers: Vec<u32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSet {
    pub round: u128,
    pub price: i128,
    pub time: u64,
    pub signers: Vec<u32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerRotated {
    pub slot: u32,
    pub key: BytesN<32>,
    pub epoch: u64,
}

/// What a signer signs for a price report on this vault.
pub fn price_message(env: &Env, round: u128, price: i128, updated_at: u64) -> BytesN<32> {
    let msg = (symbol_short!("zkp_price"), env.current_contract_address(), round, price, updated_at).to_xdr(env);
    env.crypto().sha256(&msg).to_bytes()
}

/// What signers sign to put `key` in `slot` at rotation number `epoch`. Its
/// own domain, so a rotation never passes as a price.
pub fn rotation_message(env: &Env, epoch: u64, slot: u32, key: &BytesN<32>) -> BytesN<32> {
    let msg = (symbol_short!("zkp_rotat"), env.current_contract_address(), epoch, slot, key.clone()).to_xdr(env);
    env.crypto().sha256(&msg).to_bytes()
}

/// Two signatures on `digest`, by the signers in slots `first` < `second`.
/// An invalid signature traps (the host aborts the transaction).
fn signed_by_two(
    env: &Env,
    signers: &Vec<BytesN<32>>,
    digest: &BytesN<32>,
    first: u32,
    second: u32,
    sig_a: &BytesN<64>,
    sig_b: &BytesN<64>,
) -> Result<(), Error> {
    if !(first < second && second < SIGNERS) {
        return Err(Error::InvalidSignerSlots);
    }
    let msg = digest.clone().into();
    env.crypto().ed25519_verify(&signers.get_unchecked(first), &msg, sig_a);
    env.crypto().ed25519_verify(&signers.get_unchecked(second), &msg, sig_b);
    Ok(())
}

/// Three distinct keys.
pub fn valid_signers(signers: &Vec<BytesN<32>>) -> bool {
    signers.len() == SIGNERS
        && signers.get_unchecked(0) != signers.get_unchecked(1)
        && signers.get_unchecked(0) != signers.get_unchecked(2)
        && signers.get_unchecked(1) != signers.get_unchecked(2)
}

#[contractimpl]
impl ZkPerpVault {
    /// Sets the mark price from a Chainlink round signed by two of the three
    /// signers. Anyone may submit it.
    pub fn set_price(
        env: Env,
        round: u128,
        price: i128,
        updated_at: u64,
        first: u32,
        second: u32,
        sig_a: BytesN<64>,
        sig_b: BytesN<64>,
    ) -> Result<(), Error> {
        let config = Self::perp_config(env.clone())?;
        let digest = price_message(&env, round, price, updated_at);
        signed_by_two(&env, &config.signers, &digest, first, second, &sig_a, &sig_b)?;
        if price <= 0 || price > i64::MAX as i128 {
            return Err(Error::InvalidPrice);
        }
        if updated_at > env.ledger().timestamp() {
            return Err(Error::PriceTimeInvalid);
        }
        if let Some(current) = env.storage().instance().get::<_, MarkPrice>(&DataKey::Mark) {
            if round <= current.round {
                return Err(Error::StaleRound);
            }
            if updated_at < current.time {
                return Err(Error::PriceTimeInvalid);
            }
        }
        let signers = soroban_sdk::vec![&env, first, second];
        let mark = MarkPrice { price, time: updated_at, round, signers: signers.clone() };
        env.storage().instance().set(&DataKey::Mark, &mark);
        PriceSet { round, price, time: updated_at, signers }.publish(&env);
        Ok(())
    }

    /// Puts `key` in signer slot `slot`, signed by the signers in two slots:
    /// to replace a lost or leaked key, or to refresh one's own.
    pub fn rotate_signer(
        env: Env,
        slot: u32,
        key: BytesN<32>,
        first: u32,
        second: u32,
        sig_a: BytesN<64>,
        sig_b: BytesN<64>,
    ) -> Result<(), Error> {
        let mut config = Self::perp_config(env.clone())?;
        if slot >= SIGNERS {
            return Err(Error::InvalidSignerSlots);
        }
        let epoch = Self::signer_epoch(env.clone());
        let digest = rotation_message(&env, epoch, slot, &key);
        signed_by_two(&env, &config.signers, &digest, first, second, &sig_a, &sig_b)?;
        config.signers.set(slot, key.clone());
        if !valid_signers(&config.signers) {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Perp, &config);
        s.set(&DataKey::SignerEpoch, &(epoch + 1));
        SignerRotated { slot, key, epoch }.publish(&env);
        Ok(())
    }

    pub fn mark_price(env: Env) -> Result<MarkPrice, Error> {
        env.storage().instance().get(&DataKey::Mark).ok_or(Error::NoPrice)
    }

    /// Rotations so far; part of the next rotation's message.
    pub fn signer_epoch(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::SignerEpoch).unwrap_or(0)
    }

    /// The digest signers sign for a price report, so clients can check
    /// they build the same bytes.
    pub fn price_digest(env: Env, round: u128, price: i128, updated_at: u64) -> BytesN<32> {
        price_message(&env, round, price, updated_at)
    }

    pub fn rotation_digest(env: Env, epoch: u64, slot: u32, key: BytesN<32>) -> BytesN<32> {
        rotation_message(&env, epoch, slot, &key)
    }
}
