//! Limit orders (step 13). Midnight's placeLimitOrder / executeLimitOrder /
//! cancelLimitOrder.
//!
//! The owner escrows collateral from a private note into a limit-order
//! commitment (side, size, collateral, limit, owner hash, salt) with a note for
//! the keepers; nothing about the order is public. A registered keeper fills it
//! once the mark price reached the limit, opening the position at the mark
//! price under the normal open rules. The owner can cancel an unfilled order
//! and get the collateral back as a note. The collateral stays in trader funds
//! throughout, so no token moves.

use crate::{
    merkle,
    notes::{check_inputs, mark_spent, verify},
    perp::check_open,
    DataKey, Error, KeeperKey, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient,
};
use groth16::{Proof, VerificationKey};
use soroban_sdk::{contractevent, contractimpl, contracttype, Address, Env, Vec, U256};

/// place_limit: 11 outputs (nullifier, order, change, R, 6 note fields) + 3 inputs (root, keeperPk).
pub const PLACE_LIMIT_PUBLIC_INPUTS: u32 = 14;
/// execute_limit: 1 output (position) + 4 inputs (order, entry, openTime, feeBps).
pub const EXECUTE_LIMIT_PUBLIC_INPUTS: u32 = 5;
/// cancel_limit: 1 output (refund) + 1 input (order).
pub const CANCEL_LIMIT_PUBLIC_INPUTS: u32 = 2;
const LIMIT_TTL: u32 = 3_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitFill {
    pub leaf_index: u32,
    pub entry_price: i128,
    pub open_time: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitPlaced {
    #[topic]
    pub order: U256,
    pub nullifier: U256,
    pub change_leaf: u32,
    pub change_commitment: U256,
    pub note_r: KeeperKey,
    pub note: Vec<U256>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitFilled {
    #[topic]
    pub order: U256,
    pub keeper: Address,
    pub leaf_index: u32,
    pub commitment: U256,
    pub entry_price: i128,
    pub open_time: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitCancelled {
    #[topic]
    pub order: U256,
    pub refund_leaf: u32,
    pub refund_commitment: U256,
}

#[contractimpl]
impl ZkPerpVault {
    /// Turns on limit orders. Admin only, once (after `init_liquidation`).
    pub fn init_limits(env: Env, place_vk: VerificationKey, execute_vk: VerificationKey, cancel_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        Self::liquidation_config(env.clone())?;
        if env.storage().persistent().has(&DataKey::PlaceLimitVk) {
            return Err(Error::LimitsAlreadyInitialized);
        }
        Self::store_limit_vks(&env, place_vk, execute_vk, cancel_vk)
    }

    pub fn set_limit_vks(env: Env, place_vk: VerificationKey, execute_vk: VerificationKey, cancel_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if !env.storage().persistent().has(&DataKey::PlaceLimitVk) {
            return Err(Error::LimitsNotInitialized);
        }
        Self::store_limit_vks(&env, place_vk, execute_vk, cancel_vk)
    }

    /// Escrows collateral from a note into a limit order. Needs no signature.
    /// Returns the change note's leaf.
    pub fn place_limit(env: Env, root: U256, nullifier: U256, order: U256, change: U256, note_r: KeeperKey, note: Vec<U256>, proof: Proof) -> Result<u32, Error> {
        let config = Self::perp_config(env.clone())?;
        if !merkle::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }
        if note.len() != 6 {
            return Err(Error::InvalidNote);
        }
        let mut inputs = Vec::new(&env);
        for x in [nullifier.clone(), order.clone(), change.clone(), note_r.x.clone(), note_r.y.clone()] {
            inputs.push_back(x);
        }
        for e in note.iter() {
            inputs.push_back(e);
        }
        inputs.push_back(root);
        inputs.push_back(config.keeper_key.x.clone());
        inputs.push_back(config.keeper_key.y.clone());
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::PlaceLimitVk, &proof, &inputs)?;
        let key = DataKey::LimitOrder(order.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::OrderExists);
        }
        mark_spent(&env, &nullifier)?;
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, LIMIT_TTL, LIMIT_TTL);
        let (change_leaf, _) = merkle::insert(&env, change.clone());
        LimitPlaced { order, nullifier, change_leaf, change_commitment: change, note_r, note }.publish(&env);
        Ok(change_leaf)
    }

    /// A registered keeper fills a limit order whose limit the mark price
    /// reached: opens the position at the mark. Returns the position's leaf.
    pub fn execute_limit(env: Env, keeper: Address, order: U256, commitment: U256, open_time: u64, proof: Proof) -> Result<u32, Error> {
        keeper.require_auth();
        if !Self::liquidation_config(env.clone())?.keepers.contains(&keeper) {
            return Err(Error::NotAKeeper);
        }
        let key = DataKey::LimitOrder(order.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoSuchOrder);
        }
        let config = Self::perp_config(env.clone())?;
        let (mark, live) = check_open(&env, &config, open_time)?;
        let mut inputs = Vec::new(&env);
        for x in [
            commitment.clone(),
            order.clone(),
            U256::from_u128(&env, mark.price as u128),
            U256::from_u128(&env, open_time as u128),
            U256::from_u32(&env, config.fee_bps),
        ] {
            inputs.push_back(x);
        }
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::ExecuteLimitVk, &proof, &inputs)?;
        env.storage().persistent().remove(&key);
        env.storage().instance().set(&DataKey::LivePositions, &(live + 1));
        let (leaf_index, _) = merkle::insert(&env, commitment.clone());
        let fill_key = DataKey::LimitFill(order.clone());
        env.storage().persistent().set(&fill_key, &LimitFill { leaf_index, entry_price: mark.price, open_time });
        env.storage().persistent().extend_ttl(&fill_key, LIMIT_TTL, LIMIT_TTL);
        LimitFilled { order, keeper, leaf_index, commitment, entry_price: mark.price, open_time }.publish(&env);
        Ok(leaf_index)
    }

    /// The owner cancels an unfilled order; the collateral comes back as a
    /// note (returned leaf). Needs no signature: the proof shows ownership.
    pub fn cancel_limit(env: Env, order: U256, refund: U256, proof: Proof) -> Result<u32, Error> {
        let key = DataKey::LimitOrder(order.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoSuchOrder);
        }
        let mut inputs = Vec::new(&env);
        inputs.push_back(refund.clone());
        inputs.push_back(order.clone());
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::CancelLimitVk, &proof, &inputs)?;
        env.storage().persistent().remove(&key);
        let (refund_leaf, _) = merkle::insert(&env, refund.clone());
        LimitCancelled { order, refund_leaf, refund_commitment: refund }.publish(&env);
        Ok(refund_leaf)
    }

    pub fn is_limit_open(env: Env, order: U256) -> bool {
        env.storage().persistent().has(&DataKey::LimitOrder(order))
    }

    /// Where and at what price a limit order was filled (for its owner).
    pub fn limit_fill(env: Env, order: U256) -> Option<LimitFill> {
        env.storage().persistent().get(&DataKey::LimitFill(order))
    }
}

impl ZkPerpVault {
    fn store_limit_vks(env: &Env, place_vk: VerificationKey, execute_vk: VerificationKey, cancel_vk: VerificationKey) -> Result<(), Error> {
        if place_vk.ic.len() != PLACE_LIMIT_PUBLIC_INPUTS + 1
            || execute_vk.ic.len() != EXECUTE_LIMIT_PUBLIC_INPUTS + 1
            || cancel_vk.ic.len() != CANCEL_LIMIT_PUBLIC_INPUTS + 1
        {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().persistent();
        s.set(&DataKey::PlaceLimitVk, &place_vk);
        s.set(&DataKey::ExecuteLimitVk, &execute_vk);
        s.set(&DataKey::CancelLimitVk, &cancel_vk);
        Ok(())
    }
}
