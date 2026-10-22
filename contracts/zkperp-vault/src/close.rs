//! Closing positions (step 7). Soroban counterpart of `closePosition` /
//! `settle` in zkperp-midnight.
//!
//! The owner proves the position is in the tree and theirs, and the vault
//! settles it at the mark price: a profit (capped at `max_payout`) comes out
//! of the pool, a loss goes into it. The trader's payout and the treasury's
//! fees become private notes, so the only public amounts are the pool's
//! change: `pool_in` (loss) and `pool_out` (profit). Like a private open, a
//! close needs no signature; a relayer submits it. Closing frees the
//! position's `max_payout` reservation.

use crate::{
    get_instance, merkle,
    notes::{check_inputs, mark_spent, verify},
    DataKey, Error, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient, CLOCK_SLACK,
};
use groth16::{Proof, VerificationKey};
use soroban_sdk::{contractevent, contractimpl, Env, Vec, U256};

/// close_position: 5 outputs (nullifier, payout, fee, poolIn, poolOut) + 7 inputs.
pub const CLOSE_PUBLIC_INPUTS: u32 = 12;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionClosed {
    #[topic]
    pub nullifier: U256,
    pub exit_price: i128,
    /// Loss into the pool.
    pub pool_in: i128,
    /// Profit out of the pool.
    pub pool_out: i128,
    pub payout_leaf: u32,
    pub payout_commitment: U256,
    pub fee_leaf: u32,
    pub fee_commitment: U256,
    pub root: U256,
    /// Close time and borrow rate the fees were computed with (step 10).
    pub time: u64,
    pub borrow_rate: u32,
}

#[contractimpl]
impl ZkPerpVault {
    /// Turns on closing. Admin only, once. `treasury_owner` is the owner hash,
    /// Poseidon(treasury secret), that receives every close's fee note.
    pub fn init_close(env: Env, close_vk: VerificationKey, treasury_owner: U256) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        Self::perp_config(env.clone())?;
        let s = env.storage().persistent();
        if s.has(&DataKey::CloseVk) {
            return Err(Error::CloseAlreadyInitialized);
        }
        Self::store_close_config(&env, close_vk, treasury_owner)
    }

    /// Replaces the close verification key and/or the treasury owner. Admin only.
    pub fn set_close_config(env: Env, close_vk: VerificationKey, treasury_owner: U256) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if !env.storage().persistent().has(&DataKey::CloseVk) {
            return Err(Error::CloseNotInitialized);
        }
        Self::store_close_config(&env, close_vk, treasury_owner)
    }

    /// Closes a position at the mark price. Needs no signature. Returns the
    /// payout note's leaf; the treasury's fee note is the next leaf.
    pub fn close_position(
        env: Env,
        root: U256,
        nullifier: U256,
        payout: U256,
        fee: U256,
        pool_in: i128,
        pool_out: i128,
        close_time: u64,
        proof: Proof,
    ) -> Result<u32, Error> {
        let s = settle_position(&env, DataKey::CloseVk, None, &root, &nullifier, &payout, &fee, pool_in, pool_out, close_time, &proof)?;
        PositionClosed {
            nullifier,
            exit_price: s.exit_price,
            pool_in,
            pool_out,
            payout_leaf: s.payout_leaf,
            payout_commitment: payout,
            fee_leaf: s.payout_leaf + 1,
            fee_commitment: fee,
            root: s.root,
            time: close_time,
            borrow_rate: s.borrow_rate,
        }
        .publish(&env);
        Ok(s.payout_leaf)
    }

    /// Sets the borrow rate (step 10): per second, scaled by 10^12; the fee
    /// is ceil(size * rate * seconds held / 10^12), charged at close or
    /// liquidation. Midnight's demo rate is 27,778 (0.01% of size per hour).
    /// Admin only. Applies to every open position from then on.
    pub fn set_borrow_rate(env: Env, rate: u32) {
        Self::admin(env.clone()).require_auth();
        env.storage().instance().set(&DataKey::BorrowRate, &rate);
    }

    pub fn borrow_rate(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::BorrowRate).unwrap_or(0)
    }

    /// The owner hash that receives fee notes.
    pub fn treasury_owner(env: Env) -> Result<U256, Error> {
        env.storage().persistent().get(&DataKey::TreasuryOwner).ok_or(Error::CloseNotInitialized)
    }
}

impl ZkPerpVault {
    fn store_close_config(env: &Env, close_vk: VerificationKey, treasury_owner: U256) -> Result<(), Error> {
        if close_vk.ic.len() != CLOSE_PUBLIC_INPUTS + 1 || !zkperp_poseidon::in_field(env, &treasury_owner) {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().persistent();
        s.set(&DataKey::CloseVk, &close_vk);
        s.set(&DataKey::TreasuryOwner, &treasury_owner);
        Ok(())
    }
}

/// What a settled close (or executed order) produced.
pub(crate) struct Settled {
    pub exit_price: i128,
    pub borrow_rate: u32,
    pub payout_leaf: u32,
    pub root: U256,
}

/// Verifies and settles a close-style proof (close_position, or
/// execute_order with `extra` = the order id as last public input): checks
/// time, price, root and amounts, verifies against `vk_key`, spends the
/// position, moves PnL between the pool and trader funds, frees the
/// reservation and inserts the payout and fee notes.
#[allow(clippy::too_many_arguments)]
pub(crate) fn settle_position(
    env: &Env,
    vk_key: DataKey,
    extra: Option<U256>,
    root: &U256,
    nullifier: &U256,
    payout: &U256,
    fee: &U256,
    pool_in: i128,
    pool_out: i128,
    close_time: u64,
    proof: &Proof,
) -> Result<Settled, Error> {
    let config = ZkPerpVault::perp_config(env.clone())?;
    let treasury: U256 = env.storage().persistent().get(&DataKey::TreasuryOwner).ok_or(Error::CloseNotInitialized)?;
    let now = env.ledger().timestamp();
    if close_time > now || now - close_time > CLOCK_SLACK {
        return Err(Error::BadCloseTime);
    }
    let mark = ZkPerpVault::mark_price(env.clone())?;
    if now - mark.time > config.max_price_age {
        return Err(Error::StalePrice);
    }
    if !merkle::is_known_root(env, root) {
        return Err(Error::UnknownRoot);
    }
    let max_payout = ZkPerpVault::max_payout(env.clone());
    let borrow_rate = ZkPerpVault::borrow_rate(env.clone());
    if pool_in < 0 || pool_in > i64::MAX as i128 || pool_out < 0 || pool_out > max_payout {
        return Err(Error::InvalidAmount);
    }
    let mut inputs = Vec::new(env);
    for x in [
        nullifier.clone(),
        payout.clone(),
        fee.clone(),
        U256::from_u128(env, pool_in as u128),
        U256::from_u128(env, pool_out as u128),
        root.clone(),
        U256::from_u128(env, mark.price as u128),
        U256::from_u128(env, close_time as u128),
        U256::from_u32(env, config.fee_bps),
        U256::from_u128(env, max_payout as u128),
        treasury,
        U256::from_u32(env, borrow_rate),
    ] {
        inputs.push_back(x);
    }
    if let Some(x) = extra {
        inputs.push_back(x);
    }
    check_inputs(env, &inputs)?;
    verify(env, vk_key, proof, &inputs)?;
    mark_spent(env, nullifier)?;

    let live = ZkPerpVault::live_positions(env.clone());
    let pool = ZkPerpVault::pool_value(env.clone()) + pool_in - pool_out;
    let funds: i128 = get_instance(env, &DataKey::CollateralHeld);
    let funds = funds + pool_out - pool_in;
    if live == 0 || pool < 0 || funds < 0 {
        return Err(Error::Overflow);
    }
    let s = env.storage().instance();
    s.set(&DataKey::LivePositions, &(live - 1));
    s.set(&DataKey::PoolValue, &pool);
    s.set(&DataKey::CollateralHeld, &funds);
    let (payout_leaf, _) = merkle::insert(env, payout.clone());
    let (_, root_after) = merkle::insert(env, fee.clone());
    Ok(Settled { exit_price: mark.price, borrow_rate, payout_leaf, root: root_after })
}
