//! Shielded collateral (step 6): private notes in the vault's commitment tree.
//!
//! - `deposit_note`: public transfer in (amount and sender visible); the vault
//!   recomputes the note commitment Poseidon(amount, inner) and inserts it.
//! - `open_position_private`: spends a note to open a position. No token
//!   moves and no account signs: the proof is the authority, so anyone (a
//!   relayer) can submit it. The collateral amount and the trader stay private.
//! - `withdraw_note`: spends a note and pays `amount` publicly to `recipient`,
//!   which is bound into the proof so a relayer can't redirect it.
//!
//! Spent notes are recorded by nullifier, Poseidon(salt, leaf_index).

use crate::{
    get_instance, merkle, perp::check_open, DataKey, Error, KeeperKey, ZkPerpVault, ZkPerpVaultArgs, ZkPerpVaultClient,
};
use groth16::{verify_groth16, Proof, VerificationKey};
use soroban_sdk::{contractevent, contractimpl, token, xdr::ToXdr, Address, Bytes, Env, Vec, U256};
use zkperp_poseidon::{in_field, Params};

/// open_private: 13 outputs (nullifier, commitment, change, R, 8 note fields) + 6 inputs.
pub const OPEN_PRIVATE_PUBLIC_INPUTS: u32 = 19;
/// withdraw_note: 2 outputs (nullifier, change) + 3 inputs (root, amount, recipient).
pub const WITHDRAW_PUBLIC_INPUTS: u32 = 5;

// Nullifiers must never be forgotten: extend to ~173 days on every write.
// (An archived entry makes `has` fail the transaction until restored; it
// never reads as "unspent".)
const NULLIFIER_TTL: u32 = 3_000_000;

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteDeposited {
    #[topic]
    pub leaf_index: u32,
    pub commitment: U256,
    pub amount: i128,
    pub root: U256,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivateOpened {
    #[topic]
    pub leaf_index: u32,
    pub commitment: U256,
    pub change_leaf: u32,
    pub change_commitment: U256,
    pub nullifier: U256,
    pub root: U256,
    pub note_r: KeeperKey,
    pub note: Vec<U256>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NoteWithdrawn {
    #[topic]
    pub nullifier: U256,
    pub amount: i128,
    pub recipient: Address,
    pub change_leaf: u32,
    pub change_commitment: U256,
    pub root: U256,
}

/// The recipient as a field element: the first 31 bytes of
/// sha256(xdr(ScVal::Address)). Matches `recipientField` in circuits/lib/notes.mjs.
pub fn recipient_field(env: &Env, recipient: &Address) -> U256 {
    let digest = env.crypto().sha256(&recipient.clone().to_xdr(env)).to_array();
    let mut be = [0u8; 32];
    be[1..].copy_from_slice(&digest[..31]);
    U256::from_be_bytes(env, &Bytes::from_array(env, &be))
}

pub(crate) fn mark_spent(env: &Env, nullifier: &U256) -> Result<(), Error> {
    let key = DataKey::Nullifier(nullifier.clone());
    let s = env.storage().persistent();
    if s.has(&key) {
        return Err(Error::NoteSpent);
    }
    s.set(&key, &true);
    s.extend_ttl(&key, NULLIFIER_TTL, NULLIFIER_TTL);
    Ok(())
}

pub(crate) fn check_inputs(env: &Env, inputs: &Vec<U256>) -> Result<(), Error> {
    for x in inputs.iter() {
        if !in_field(env, &x) {
            return Err(Error::NotInField);
        }
    }
    Ok(())
}

pub(crate) fn verify(env: &Env, key: DataKey, proof: &Proof, inputs: &Vec<U256>) -> Result<(), Error> {
    let vk: VerificationKey = env.storage().persistent().get(&key).ok_or(Error::NotesNotInitialized)?;
    if !verify_groth16(env, &vk, proof, inputs).map_err(|_| Error::InvalidProof)? {
        return Err(Error::InvalidProof);
    }
    Ok(())
}

fn add_trader_funds(env: &Env, delta: i128) -> Result<(), Error> {
    let held: i128 = get_instance(env, &DataKey::CollateralHeld);
    let next = held.checked_add(delta).ok_or(Error::Overflow)?;
    if next < 0 {
        return Err(Error::Overflow);
    }
    env.storage().instance().set(&DataKey::CollateralHeld, &next);
    Ok(())
}

#[contractimpl]
impl ZkPerpVault {
    /// Turns on shielded collateral. Admin only, once, after `init_perp`.
    pub fn init_notes(env: Env, open_private_vk: VerificationKey, withdraw_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        Self::perp_config(env.clone())?;
        if env.storage().persistent().has(&DataKey::OpenPrivateVk) {
            return Err(Error::NotesAlreadyInitialized);
        }
        Self::store_note_vks(&env, open_private_vk, withdraw_vk)
    }

    /// Replaces both note circuits' verification keys. Admin only.
    /// ⚠️ Whoever sets these can forge spends; production puts it behind a timelock.
    pub fn set_note_vks(env: Env, open_private_vk: VerificationKey, withdraw_vk: VerificationKey) -> Result<(), Error> {
        Self::admin(env.clone()).require_auth();
        if !env.storage().persistent().has(&DataKey::OpenPrivateVk) {
            return Err(Error::NotesNotInitialized);
        }
        Self::store_note_vks(&env, open_private_vk, withdraw_vk)
    }

    /// Deposits `amount` from `from` as a private note. `inner` =
    /// Poseidon(ownerHash, salt), computed by the depositor; the vault adds the
    /// amount itself, so the note's value can't be misstated. Returns its leaf.
    pub fn deposit_note(env: Env, from: Address, amount: i128, inner: U256) -> Result<u32, Error> {
        from.require_auth();
        if !env.storage().persistent().has(&DataKey::OpenPrivateVk) {
            return Err(Error::NotesNotInitialized);
        }
        if amount <= 0 || amount > i64::MAX as i128 {
            return Err(Error::InvalidAmount);
        }
        if !in_field(&env, &inner) {
            return Err(Error::NotInField);
        }
        token::Client::new(&env, &Self::token(env.clone())).transfer(&from, &env.current_contract_address(), &amount);
        add_trader_funds(&env, amount)?;
        let commitment = Params::t3(&env).hash(&env, &[U256::from_u128(&env, amount as u128), inner]);
        let (leaf_index, root) = merkle::insert(&env, commitment.clone());
        NoteDeposited { leaf_index, commitment, amount, root }.publish(&env);
        Ok(leaf_index)
    }

    /// Opens a position with collateral from a private note. Needs no
    /// signature: anyone may submit the proof. Returns the position's leaf;
    /// the change note is the next leaf.
    pub fn open_position_private(
        env: Env,
        root: U256,
        nullifier: U256,
        commitment: U256,
        change: U256,
        note_r: KeeperKey,
        note: Vec<U256>,
        open_time: u64,
        proof: Proof,
    ) -> Result<u32, Error> {
        let config = Self::perp_config(env.clone())?;
        let (mark, live) = check_open(&env, &config, open_time)?;
        if !merkle::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }
        if note.len() != 8 {
            return Err(Error::InvalidNote);
        }
        let mut inputs = Vec::new(&env);
        for x in [nullifier.clone(), commitment.clone(), change.clone(), note_r.x.clone(), note_r.y.clone()] {
            inputs.push_back(x);
        }
        for e in note.iter() {
            inputs.push_back(e);
        }
        inputs.push_back(root.clone());
        inputs.push_back(U256::from_u128(&env, mark.price as u128));
        inputs.push_back(U256::from_u128(&env, open_time as u128));
        inputs.push_back(U256::from_u32(&env, config.fee_bps));
        inputs.push_back(config.keeper_key.x.clone());
        inputs.push_back(config.keeper_key.y.clone());
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::OpenPrivateVk, &proof, &inputs)?;
        mark_spent(&env, &nullifier)?;

        env.storage().instance().set(&DataKey::LivePositions, &(live + 1));
        let (leaf_index, _) = merkle::insert(&env, commitment.clone());
        let (change_leaf, root_after) = merkle::insert(&env, change.clone());
        PrivateOpened {
            leaf_index,
            commitment,
            change_leaf,
            change_commitment: change,
            nullifier,
            root: root_after,
            note_r,
            note,
        }
        .publish(&env);
        Ok(leaf_index)
    }

    /// Spends a note and pays `amount` to `recipient`; the rest becomes a
    /// change note (returned leaf). Needs no signature.
    pub fn withdraw_note(
        env: Env,
        root: U256,
        nullifier: U256,
        amount: i128,
        recipient: Address,
        change: U256,
        proof: Proof,
    ) -> Result<u32, Error> {
        if amount <= 0 || amount > i64::MAX as i128 {
            return Err(Error::InvalidAmount);
        }
        if !merkle::is_known_root(&env, &root) {
            return Err(Error::UnknownRoot);
        }
        let mut inputs = Vec::new(&env);
        for x in [nullifier.clone(), change.clone(), root.clone(), U256::from_u128(&env, amount as u128), recipient_field(&env, &recipient)] {
            inputs.push_back(x);
        }
        check_inputs(&env, &inputs)?;
        verify(&env, DataKey::WithdrawVk, &proof, &inputs)?;
        mark_spent(&env, &nullifier)?;

        add_trader_funds(&env, -amount)?;
        token::Client::new(&env, &Self::token(env.clone())).transfer(&env.current_contract_address(), &recipient, &amount);
        let (change_leaf, root_after) = merkle::insert(&env, change.clone());
        NoteWithdrawn { nullifier, amount, recipient, change_leaf, change_commitment: change, root: root_after }.publish(&env);
        Ok(change_leaf)
    }

    pub fn is_spent(env: Env, nullifier: U256) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }

    /// `recipient_field` for clients to check their encoding.
    pub fn recipient_digest(env: Env, recipient: Address) -> U256 {
        recipient_field(&env, &recipient)
    }
}

impl ZkPerpVault {
    fn store_note_vks(env: &Env, open_private_vk: VerificationKey, withdraw_vk: VerificationKey) -> Result<(), Error> {
        if open_private_vk.ic.len() != OPEN_PRIVATE_PUBLIC_INPUTS + 1 || withdraw_vk.ic.len() != WITHDRAW_PUBLIC_INPUTS + 1 {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().persistent();
        s.set(&DataKey::OpenPrivateVk, &open_private_vk);
        s.set(&DataKey::WithdrawVk, &withdraw_vk);
        Ok(())
    }
}
