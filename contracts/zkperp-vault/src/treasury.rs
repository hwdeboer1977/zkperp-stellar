//! Treasury (step 9): merging notes and paying out the fees.
//!
//! Every close and liquidation leaves a fee note owned by the treasury
//! (step 7/8). The treasury merges them privately (`merge_notes`, which any
//! owner can use) and then collects the merged note with `collect_fees`:
//! a withdraw proof whose bound recipient is the vault itself. The collected
//! amount, an aggregate over many positions, is split: `keeper_share_bps` to
//! the registered keepers (equal shares, claimable with `claim_keeper_fees`),
//! the rest to the pool as LP revenue (no shares minted, so every zLP share
//! gains value, as Midnight's `depositFees`).

use crate::{
    get_instance, merkle,
    notes::{check_inputs, mark_spent, recipient_field, verify},
    DataKey, Error, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient,
};
use groth16::{Proof, VerificationKey};
use soroban_sdk::{contractevent, contractimpl, token, Address, Env, Vec, U256};

/// merge_notes: 3 outputs (nullifier A, nullifier B, merged) + 1 input (root).
pub const MERGE_PUBLIC_INPUTS: u32 = 4;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotesMerged {
    pub nullifier_a: U256,
    pub nullifier_b: U256,
    pub leaf_index: u32,
    pub commitment: U256,
    pub root: U256,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesCollected {
    pub nullifier: U256,
    pub amount: i128,
    pub to_pool: i128,
    pub per_keeper: i128,
    pub change_leaf: u32,
    pub change_commitment: U256,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperPaid {
    #[topic]
    pub keeper: Address,
    pub amount: i128,
}

#[contractimpl]
impl ZkPerpVault {
    /// Turns on merging and fee collection. Admin only, once (after
    /// `init_liquidation`, whose keepers share the fees).
    pub fn init_treasury(env: Env, merge_vk: VerificationKey, keeper_share_bps: u32) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        Self::liquidation_config(env.clone())?;
        if env.storage().persistent().has(&DataKey::MergeVk) {
            return Err(Error::TreasuryAlreadyInitialized);
        }
        Self::store_treasury_config(&env, merge_vk, keeper_share_bps)
    }

    pub fn set_treasury_config(env: Env, merge_vk: VerificationKey, keeper_share_bps: u32) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if !env.storage().persistent().has(&DataKey::MergeVk) {
            return Err(Error::TreasuryNotInitialized);
        }
        Self::store_treasury_config(&env, merge_vk, keeper_share_bps)
    }

    /// Joins two notes of the same owner into one. Needs no signature.
    pub fn merge_notes(env: Env, root: U256, nullifier_a: U256, nullifier_b: U256, merged: U256, proof: Proof) -> Result<u32, Error> {
        if !merkle::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }
        let mut inputs = Vec::new(&env);
        for x in [nullifier_a.clone(), nullifier_b.clone(), merged.clone(), root] {
            inputs.push_back(x);
        }
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::MergeVk, &proof, &inputs)?;
        mark_spent(&env, &nullifier_a)?;
        mark_spent(&env, &nullifier_b)?;
        let (leaf_index, root_after) = merkle::insert(&env, merged.clone());
        NotesMerged { nullifier_a, nullifier_b, leaf_index, commitment: merged, root: root_after }.publish(&env);
        Ok(leaf_index)
    }

    /// Collects `amount` of a note (normally the treasury's merged fee note)
    /// into fee distribution: a withdraw proof whose recipient is this vault.
    /// The rest of the note becomes a change note (returned leaf).
    pub fn collect_fees(env: Env, root: U256, nullifier: U256, amount: i128, change: U256, proof: Proof) -> Result<u32, Error> {
        let bps: u32 = env.storage().persistent().get(&DataKey::KeeperShareBps).ok_or(Error::TreasuryNotInitialized)?;
        let keepers = Self::liquidation_config(env.clone())?.keepers;
        if amount <= 0 || amount > i64::MAX as i128 {
            return Err(Error::InvalidAmount);
        }
        if !merkle::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }
        let me = env.current_contract_address();
        let mut inputs = Vec::new(&env);
        for x in [nullifier.clone(), change.clone(), root, U256::from_u128(&env, amount as u128), recipient_field(&env, &me)] {
            inputs.push_back(x);
        }
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::WithdrawVk, &proof, &inputs)?;
        mark_spent(&env, &nullifier)?;

        let n = keepers.len() as i128;
        let per_keeper = amount * bps as i128 / 10_000 / n;
        let to_pool = amount - per_keeper * n;
        let funds: i128 = get_instance(&env, &DataKey::CollateralHeld);
        if funds < amount {
            return Err(Error::Overflow);
        }
        let s = env.storage().instance();
        s.set(&DataKey::CollateralHeld, &(funds - amount));
        s.set(&DataKey::PoolValue, &(Self::pool_value(env.clone()) + to_pool));
        if per_keeper > 0 {
            for k in keepers.iter() {
                let key = DataKey::KeeperOwed(k);
                let owed: i128 = env.storage().persistent().get(&key).unwrap_or(0);
                env.storage().persistent().set(&key, &(owed + per_keeper));
            }
            s.set(&DataKey::KeeperOwedTotal, &(Self::keeper_owed_total(env.clone()) + per_keeper * n));
        }
        let (change_leaf, _) = merkle::insert(&env, change.clone());
        FeesCollected { nullifier, amount, to_pool, per_keeper, change_leaf, change_commitment: change }.publish(&env);
        Ok(change_leaf)
    }

    /// Pays `keeper` its share of collected fees. The keeper signs.
    pub fn claim_keeper_fees(env: Env, keeper: Address) -> Result<i128, Error> {
        keeper.require_auth();
        let key = DataKey::KeeperOwed(keeper.clone());
        let owed: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if owed <= 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage().persistent().remove(&key);
        env.storage().instance().set(&DataKey::KeeperOwedTotal, &(Self::keeper_owed_total(env.clone()) - owed));
        token::Client::new(&env, &Self::token(env.clone())).transfer(&env.current_contract_address(), &keeper, &owed);
        KeeperPaid { keeper, amount: owed }.publish(&env);
        Ok(owed)
    }

    pub fn keeper_owed(env: Env, keeper: Address) -> i128 {
        env.storage().persistent().get(&DataKey::KeeperOwed(keeper)).unwrap_or(0)
    }

    /// Owed to keepers, not yet claimed. Token balance = pool_value + trader_funds + this.
    pub fn keeper_owed_total(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::KeeperOwedTotal).unwrap_or(0)
    }

    pub fn keeper_share_bps(env: Env) -> Result<u32, Error> {
        env.storage().persistent().get(&DataKey::KeeperShareBps).ok_or(Error::TreasuryNotInitialized)
    }
}

impl ZkPerpVault {
    fn store_treasury_config(env: &Env, merge_vk: VerificationKey, keeper_share_bps: u32) -> Result<(), Error> {
        if merge_vk.ic.len() != MERGE_PUBLIC_INPUTS + 1 || keeper_share_bps > 10_000 {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().persistent();
        s.set(&DataKey::MergeVk, &merge_vk);
        s.set(&DataKey::KeeperShareBps, &keeper_share_bps);
        Ok(())
    }
}
