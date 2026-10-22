//! Liquidation by keepers (step 8). Soroban counterpart of
//! `liquidatePosition` in zkperp-midnight.
//!
//! A registered keeper (Soroban auth, ARCHITECTURE §3) proves that a position
//! is below the maintenance margin at the mark price, using the fields it
//! decrypted from the keeper note (it never has the owner secret). The loss
//! goes into the pool; what equity is left goes to a note for the position's
//! owner; the fees (open + close + liquidation) to the treasury's note.
//! Keepers are paid from the treasury: a public keeper fee would reveal the
//! position's size.

use crate::{
    get_instance, merkle,
    notes::{check_inputs, mark_spent, verify},
    DataKey, Error, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient, CLOCK_SLACK,
};
use groth16::{Proof, VerificationKey};
use soroban_sdk::{contractevent, contractimpl, contracttype, Address, Env, Vec, U256};

/// liquidate_position: 4 outputs (nullifier, payout, fee, poolIn) + 8 inputs.
pub const LIQUIDATE_PUBLIC_INPUTS: u32 = 12;
const RECORD_TTL: u32 = 3_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationConfig {
    /// The keepers' Stellar accounts; any one of them may liquidate.
    pub keepers: Vec<Address>,
    /// Liquidatable when equity < size × maintenance_bps / 10000 (Midnight: 250).
    pub maintenance_bps: u32,
    /// Liquidation fee, basis points of size, out of the equity (Midnight: 50).
    pub liquidation_fee_bps: u32,
}

/// Kept per liquidated position so its owner can find their payout note later
/// (they know the position's nullifier).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidationRecord {
    pub exit_price: i128,
    pub payout_leaf: u32,
    pub time: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionLiquidated {
    #[topic]
    pub nullifier: U256,
    pub keeper: Address,
    pub exit_price: i128,
    pub pool_in: i128,
    pub payout_leaf: u32,
    pub payout_commitment: U256,
    pub fee_leaf: u32,
    pub fee_commitment: U256,
    pub root: U256,
    /// Liquidation time and borrow rate the fees were computed with (step 10).
    pub time: u64,
    pub borrow_rate: u32,
}

#[contractimpl]
impl ZkPerpVault {
    /// Turns on liquidation. Admin only, once (after `init_close`, which sets the treasury).
    pub fn init_liquidation(env: Env, liquidate_vk: VerificationKey, config: LiquidationConfig) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        Self::treasury_owner(env.clone())?;
        if env.storage().persistent().has(&DataKey::LiquidateVk) {
            return Err(Error::LiquidationAlreadyInitialized);
        }
        Self::store_liquidation_config(&env, liquidate_vk, config)
    }

    /// Replaces the key and/or config (keepers, margins). Admin only.
    pub fn set_liquidation_config(env: Env, liquidate_vk: VerificationKey, config: LiquidationConfig) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if !env.storage().persistent().has(&DataKey::LiquidateVk) {
            return Err(Error::LiquidationNotInitialized);
        }
        Self::store_liquidation_config(&env, liquidate_vk, config)
    }

    /// Liquidates a position below maintenance. `keeper` must be registered
    /// and sign. Returns the owner's payout note leaf; the fee note is next.
    pub fn liquidate(
        env: Env,
        keeper: Address,
        root: U256,
        nullifier: U256,
        payout: U256,
        fee: U256,
        pool_in: i128,
        liq_time: u64,
        proof: Proof,
    ) -> Result<u32, Error> {
        keeper.require_auth();
        let lc = Self::liquidation_config(env.clone())?;
        if !lc.keepers.contains(&keeper) {
            return Err(Error::NotAKeeper);
        }
        let config = Self::perp_config(env.clone())?;
        let treasury = Self::treasury_owner(env.clone())?;
        let now = env.ledger().timestamp();
        if liq_time > now || now - liq_time > CLOCK_SLACK {
            return Err(Error::BadCloseTime);
        }
        let mark = Self::mark_price(env.clone())?;
        if now - mark.time > config.max_price_age {
            return Err(Error::StalePrice);
        }
        if !merkle::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }
        if pool_in < 0 || pool_in > i64::MAX as i128 {
            return Err(Error::InvalidAmount);
        }
        let borrow_rate = Self::borrow_rate(env.clone());

        let mut inputs = Vec::new(&env);
        for x in [
            nullifier.clone(),
            payout.clone(),
            fee.clone(),
            U256::from_u128(&env, pool_in as u128),
            root,
            U256::from_u128(&env, mark.price as u128),
            U256::from_u128(&env, liq_time as u128),
            U256::from_u32(&env, config.fee_bps),
            treasury,
            U256::from_u32(&env, lc.maintenance_bps),
            U256::from_u32(&env, lc.liquidation_fee_bps),
            U256::from_u32(&env, borrow_rate),
        ] {
            inputs.push_back(x);
        }
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::LiquidateVk, &proof, &inputs)?;
        mark_spent(&env, &nullifier)?;

        let live = Self::live_positions(env.clone());
        let pool = Self::pool_value(env.clone()) + pool_in;
        let funds: i128 = get_instance(&env, &DataKey::CollateralHeld);
        if live == 0 || funds < pool_in {
            return Err(Error::Overflow);
        }
        let s = env.storage().instance();
        s.set(&DataKey::LivePositions, &(live - 1));
        s.set(&DataKey::PoolValue, &pool);
        s.set(&DataKey::CollateralHeld, &(funds - pool_in));

        let (payout_leaf, _) = merkle::insert(&env, payout.clone());
        let (fee_leaf, root_after) = merkle::insert(&env, fee.clone());
        let key = DataKey::Liquidated(nullifier.clone());
        env.storage().persistent().set(&key, &LiquidationRecord { exit_price: mark.price, payout_leaf, time: liq_time });
        env.storage().persistent().extend_ttl(&key, RECORD_TTL, RECORD_TTL);
        PositionLiquidated {
            nullifier,
            keeper,
            exit_price: mark.price,
            pool_in,
            payout_leaf,
            payout_commitment: payout,
            fee_leaf,
            fee_commitment: fee,
            root: root_after,
            time: liq_time,
            borrow_rate,
        }
        .publish(&env);
        Ok(payout_leaf)
    }

    pub fn liquidation_config(env: Env) -> Result<LiquidationConfig, Error> {
        env.storage().persistent().get(&DataKey::LiquidationConfig).ok_or(Error::LiquidationNotInitialized)
    }

    /// How a position was liquidated, by its nullifier (for its owner).
    pub fn liquidation(env: Env, nullifier: U256) -> Option<LiquidationRecord> {
        env.storage().persistent().get(&DataKey::Liquidated(nullifier))
    }
}

impl ZkPerpVault {
    fn store_liquidation_config(env: &Env, liquidate_vk: VerificationKey, config: LiquidationConfig) -> Result<(), Error> {
        if liquidate_vk.ic.len() != LIQUIDATE_PUBLIC_INPUTS + 1
            || config.keepers.is_empty()
            || config.maintenance_bps == 0
            || config.maintenance_bps >= 10_000
            || config.liquidation_fee_bps >= 10_000
        {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().persistent();
        s.set(&DataKey::LiquidateVk, &liquidate_vk);
        s.set(&DataKey::LiquidationConfig, &config);
        Ok(())
    }
}
