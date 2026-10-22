//! Trading: opening positions. Soroban counterpart of `openPosition` in
//! zkperp-midnight. The mark price is in `oracle.rs`.
//!
//! An open is one transaction by the trader: it transfers gross collateral
//! (public), proves `open_position` against the current mark price, and the
//! vault inserts the position commitment into its Merkle tree and reserves one
//! `max_payout` slot. Direction, size, leverage, fee and owner stay private.
//! The proof also carries a note encrypted to the keepers' view key, which
//! the vault emits so keepers can read and later liquidate the position.

use crate::{get_instance, merkle, oracle, DataKey, Error, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient};
use zkperp_poseidon::in_field;
use soroban_sdk::{contractevent, contractimpl, contracttype, token, Address, BytesN, Env, Vec, U256};
use groth16::{verify_groth16, Proof, VerificationKey};

/// Max seconds an open's `open_time` may trail the ledger (as `clockSlack`
/// in zkperp-midnight). It may never be in the future.
pub const CLOCK_SLACK: u64 = 300;
/// Values the circuit range-checks to 64 bits.
const MAX_U64ISH: i128 = i64::MAX as i128;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperKey {
    pub x: U256,
    pub y: U256,
}

#[contracttype]
#[derive(Clone)]
pub struct PerpConfig {
    /// The three oracle signers' ed25519 keys; 2 of 3 sign every price.
    pub signers: Vec<BytesN<32>>,
    /// Keepers' shared BabyJubJub view key; every keeper note is encrypted to it.
    pub keeper_key: KeeperKey,
    /// Opening fee, basis points of size.
    pub fee_bps: u32,
    /// A price observed longer ago than this (seconds) is refused. Set just
    /// above the feed's heartbeat (Chainlink BTC/USD: 1 hour).
    pub max_price_age: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionOpened {
    #[topic]
    pub leaf_index: u32,
    pub commitment: U256,
    pub root: U256,
    /// Keeper note: ephemeral key R and 8 encrypted fields.
    pub note_r: KeeperKey,
    pub note: Vec<U256>,
}

#[contractimpl]
impl ZkPerpVault {
    /// Turns on trading. Admin only, once (after deploy or `upgrade`).
    pub fn init_perp(env: Env, config: PerpConfig, open_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        let s = env.storage().instance();
        if s.has(&DataKey::Perp) {
            return Err(Error::PerpAlreadyInitialized);
        }
        if config.fee_bps >= 10_000
            || config.max_price_age == 0
            || !oracle::valid_signers(&config.signers)
            || !in_field(&env, &config.keeper_key.x)
            || !in_field(&env, &config.keeper_key.y)
            || open_vk.ic.len() != OPEN_PUBLIC_INPUTS + 1
        {
            return Err(Error::InvalidConfig);
        }
        s.set(&DataKey::Perp, &config);
        s.set(&DataKey::CollateralHeld, &0i128);
        env.storage().persistent().set(&DataKey::OpenVk, &open_vk);
        merkle::init(&env);
        Ok(())
    }

    /// Replaces the open_position verification key (after a circuit change or
    /// a new trusted setup). Admin only. ⚠️ Whoever sets this key can forge
    /// opens; production puts it behind a timelock (ARCHITECTURE §11).
    pub fn set_open_vk(env: Env, open_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        Self::perp_config(env.clone())?;
        if open_vk.ic.len() != OPEN_PUBLIC_INPUTS + 1 {
            return Err(Error::InvalidConfig);
        }
        env.storage().persistent().set(&DataKey::OpenVk, &open_vk);
        Ok(())
    }

    /// Opens a position. `collateral` is transferred from `trader` (gross,
    /// including the opening fee). The proof binds the private position to
    /// `commitment` and the keeper note to it.
    pub fn open_position(
        env: Env,
        trader: Address,
        collateral: i128,
        open_time: u64,
        commitment: U256,
        note_r: KeeperKey,
        note: Vec<U256>,
        proof: Proof,
    ) -> Result<u32, Error> {
        trader.require_auth();
        let config = Self::perp_config(env.clone())?;
        if collateral <= 0 || collateral > MAX_U64ISH {
            return Err(Error::InvalidAmount);
        }
        let (mark, live) = check_open(&env, &config, open_time)?;

        // Public inputs, in the circuit's order: outputs, then inputs.
        if note.len() != 8 {
            return Err(Error::InvalidNote);
        }
        let mut inputs = Vec::new(&env);
        inputs.push_back(commitment.clone());
        inputs.push_back(note_r.x.clone());
        inputs.push_back(note_r.y.clone());
        for e in note.iter() {
            inputs.push_back(e);
        }
        inputs.push_back(U256::from_u128(&env, collateral as u128));
        inputs.push_back(U256::from_u128(&env, mark.price as u128));
        inputs.push_back(U256::from_u128(&env, open_time as u128));
        inputs.push_back(U256::from_u32(&env, config.fee_bps));
        inputs.push_back(config.keeper_key.x.clone());
        inputs.push_back(config.keeper_key.y.clone());
        // Bn254Fr::from(U256) silently reduces mod r: reject non-canonical values.
        for x in inputs.iter() {
            if !in_field(&env, &x) {
                return Err(Error::NotInField);
            }
        }
        let vk: VerificationKey = env.storage().persistent().get(&DataKey::OpenVk).unwrap();
        if !verify_groth16(&env, &vk, &proof, &inputs).map_err(|_| Error::InvalidProof)? {
            return Err(Error::InvalidProof);
        }

        token::Client::new(&env, &Self::token(env.clone())).transfer(&trader, &env.current_contract_address(), &collateral);
        let held: i128 = get_instance(&env, &DataKey::CollateralHeld);
        let s = env.storage().instance();
        s.set(&DataKey::CollateralHeld, &(held + collateral));
        s.set(&DataKey::LivePositions, &(live + 1));

        let (leaf_index, root) = merkle::insert(&env, commitment.clone());
        PositionOpened { leaf_index, commitment, root, note_r, note }.publish(&env);
        Ok(leaf_index)
    }

    pub fn perp_config(env: Env) -> Result<PerpConfig, Error> {
        env.storage().instance().get(&DataKey::Perp).ok_or(Error::PerpNotInitialized)
    }

    /// Everything traders own in the vault: private notes plus position
    /// collateral. Not part of `pool_value`; token balance = pool_value + this.
    pub fn trader_funds(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::CollateralHeld).unwrap_or(0)
    }

    pub fn merkle_root(env: Env) -> Result<U256, Error> {
        Self::perp_config(env.clone())?;
        Ok(merkle::root(&env))
    }

    pub fn is_known_root(env: Env, root: U256) -> bool {
        env.storage().instance().has(&DataKey::Perp) && merkle::is_known_root(&env, &root)
    }

    pub fn position_count(env: Env) -> u32 {
        if env.storage().instance().has(&DataKey::Perp) { merkle::next_index(&env) } else { 0 }
    }
}

/// open_position: 11 outputs (commitment, R, 8 note fields) + 6 inputs.
pub const OPEN_PUBLIC_INPUTS: u32 = 17;

/// Checks shared by every open: `open_time` within CLOCK_SLACK of the ledger,
/// a fresh mark price, and room in the pool for one more `max_payout`.
/// Returns the mark price and the current number of live positions.
pub(crate) fn check_open(env: &Env, config: &PerpConfig, open_time: u64) -> Result<(oracle::MarkPrice, u32), Error> {
    let now = env.ledger().timestamp();
    if open_time > now || now - open_time > CLOCK_SLACK {
        return Err(Error::BadOpenTime);
    }
    let mark = ZkPerpVault::mark_price(env.clone())?;
    if now - mark.time > config.max_price_age {
        return Err(Error::StalePrice);
    }
    let live = ZkPerpVault::live_positions(env.clone());
    let reserved = ((live + 1) as i128).checked_mul(ZkPerpVault::max_payout(env.clone())).ok_or(Error::Overflow)?;
    if ZkPerpVault::pool_value(env.clone()) <= reserved {
        return Err(Error::NoRoomForPosition);
    }
    Ok((mark, live))
}
