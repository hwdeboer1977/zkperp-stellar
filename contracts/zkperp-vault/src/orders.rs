//! Trigger orders: stop loss and take profit (steps 11-12). Midnight's
//! placeOrder / cancelOrder / executeOrder.
//!
//! The owner registers an order id with an order-auth proof (it owns the
//! position) and an order note encrypted to the keepers; the public sees
//! neither the position, the kind, nor the level. A registered keeper
//! executes it once the mark price crossed the level: a close (same
//! settlement as `close_position`) whose payout note goes to the owner
//! (salt Poseidon(salt, 3)). The owner can cancel with the same kind of
//! proof (action 2).

use crate::{
    close::settle_position,
    notes::{check_inputs, verify},
    DataKey, Error, KeeperKey, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient,
};
use groth16::{Proof, VerificationKey};
use soroban_sdk::{contractevent, contractimpl, contracttype, Address, Env, Vec, U256};

/// order_auth: 7 outputs (orderId, R, 4 note fields) + 4 inputs (root, action, keeperPk).
pub const ORDER_AUTH_PUBLIC_INPUTS: u32 = 11;
/// execute_order: 5 outputs + 8 inputs (close's 7 + orderId).
pub const EXECUTE_ORDER_PUBLIC_INPUTS: u32 = 13;
const ORDER_TTL: u32 = 3_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionRecord {
    pub order_id: U256,
    pub exit_price: i128,
    pub payout_leaf: u32,
    pub time: u64,
    pub borrow_rate: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderPlaced {
    #[topic]
    pub order_id: U256,
    pub note_r: KeeperKey,
    pub note: Vec<U256>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderCancelled {
    #[topic]
    pub order_id: U256,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderExecuted {
    #[topic]
    pub order_id: U256,
    pub nullifier: U256,
    pub keeper: Address,
    pub exit_price: i128,
    pub pool_in: i128,
    pub pool_out: i128,
    pub payout_leaf: u32,
    pub payout_commitment: U256,
    pub fee_leaf: u32,
    pub fee_commitment: U256,
    pub root: U256,
    pub time: u64,
    pub borrow_rate: u32,
}

fn auth_inputs(env: &Env, order_id: &U256, note_r: &KeeperKey, note: &Vec<U256>, root: &U256, action: u32, keeper: &KeeperKey) -> Vec<U256> {
    let mut v = Vec::new(env);
    v.push_back(order_id.clone());
    v.push_back(note_r.x.clone());
    v.push_back(note_r.y.clone());
    for e in note.iter() {
        v.push_back(e);
    }
    v.push_back(root.clone());
    v.push_back(U256::from_u32(env, action));
    v.push_back(keeper.x.clone());
    v.push_back(keeper.y.clone());
    v
}

#[contractimpl]
impl ZkPerpVault {
    /// Turns on trigger orders. Admin only, once (after `init_liquidation`).
    pub fn init_orders(env: Env, order_auth_vk: VerificationKey, execute_order_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        Self::liquidation_config(env.clone())?;
        if env.storage().persistent().has(&DataKey::OrderAuthVk) {
            return Err(Error::OrdersAlreadyInitialized);
        }
        Self::store_order_vks(&env, order_auth_vk, execute_order_vk)
    }

    pub fn set_order_vks(env: Env, order_auth_vk: VerificationKey, execute_order_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if !env.storage().persistent().has(&DataKey::OrderAuthVk) {
            return Err(Error::OrdersNotInitialized);
        }
        Self::store_order_vks(&env, order_auth_vk, execute_order_vk)
    }

    /// Registers a stop loss or take profit. Needs no signature (the proof
    /// shows ownership); the relayer submits it.
    pub fn place_order(env: Env, root: U256, order_id: U256, note_r: KeeperKey, note: Vec<U256>, proof: Proof) -> Result<(), Error> {
        Self::order_auth(&env, &root, &order_id, &note_r, &note, 1, &proof)?;
        let key = DataKey::Order(order_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::OrderExists);
        }
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, ORDER_TTL, ORDER_TTL);
        OrderPlaced { order_id, note_r, note }.publish(&env);
        Ok(())
    }

    /// Removes an order; the proof (action 2) shows the caller owns its position.
    pub fn cancel_order(env: Env, root: U256, order_id: U256, note_r: KeeperKey, note: Vec<U256>, proof: Proof) -> Result<(), Error> {
        Self::order_auth(&env, &root, &order_id, &note_r, &note, 2, &proof)?;
        let key = DataKey::Order(order_id.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoSuchOrder);
        }
        env.storage().persistent().remove(&key);
        OrderCancelled { order_id }.publish(&env);
        Ok(())
    }

    /// A registered keeper executes an order whose level the mark price
    /// crossed: closes the position. Returns the owner's payout leaf.
    #[allow(clippy::too_many_arguments)]
    pub fn execute_order(
        env: Env,
        keeper: Address,
        order_id: U256,
        root: U256,
        nullifier: U256,
        payout: U256,
        fee: U256,
        pool_in: i128,
        pool_out: i128,
        close_time: u64,
        proof: Proof,
    ) -> Result<u32, Error> {
        keeper.require_auth();
        if !Self::liquidation_config(env.clone())?.keepers.contains(&keeper) {
            return Err(Error::NotAKeeper);
        }
        let key = DataKey::Order(order_id.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoSuchOrder);
        }
        let s = settle_position(&env, DataKey::ExecuteOrderVk, Some(order_id.clone()), &root, &nullifier, &payout, &fee, pool_in, pool_out, close_time, &proof)?;
        env.storage().persistent().remove(&key);
        let rec_key = DataKey::OrderExecuted(nullifier.clone());
        env.storage().persistent().set(&rec_key, &ExecutionRecord {
            order_id: order_id.clone(),
            exit_price: s.exit_price,
            payout_leaf: s.payout_leaf,
            time: close_time,
            borrow_rate: s.borrow_rate,
        });
        env.storage().persistent().extend_ttl(&rec_key, ORDER_TTL, ORDER_TTL);
        OrderExecuted {
            order_id,
            nullifier,
            keeper,
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

    pub fn is_order_open(env: Env, order_id: U256) -> bool {
        env.storage().persistent().has(&DataKey::Order(order_id))
    }

    /// How a position was closed by an order, by its nullifier (for its owner).
    pub fn order_execution(env: Env, nullifier: U256) -> Option<ExecutionRecord> {
        env.storage().persistent().get(&DataKey::OrderExecuted(nullifier))
    }
}

impl ZkPerpVault {
    fn order_auth(env: &Env, root: &U256, order_id: &U256, note_r: &KeeperKey, note: &Vec<U256>, action: u32, proof: &Proof) -> Result<(), Error> {
        let config = Self::perp_config(env.clone())?;
        if !crate::merkle::is_known_root(env, root) {
            return Err(Error::UnknownRoot);
        }
        if note.len() != 4 {
            return Err(Error::InvalidNote);
        }
        let inputs = auth_inputs(env, order_id, note_r, note, root, action, &config.keeper_key);
        check_inputs(env, &inputs)?;
        verify(env, DataKey::OrderAuthVk, proof, &inputs)
    }

    fn store_order_vks(env: &Env, order_auth_vk: VerificationKey, execute_order_vk: VerificationKey) -> Result<(), Error> {
        if order_auth_vk.ic.len() != ORDER_AUTH_PUBLIC_INPUTS + 1 || execute_order_vk.ic.len() != EXECUTE_ORDER_PUBLIC_INPUTS + 1 {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().persistent();
        s.set(&DataKey::OrderAuthVk, &order_auth_vk);
        s.set(&DataKey::ExecuteOrderVk, &execute_order_vk);
        Ok(())
    }
}
