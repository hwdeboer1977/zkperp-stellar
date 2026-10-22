//! Incremental Poseidon(2) Merkle tree of position commitments, depth 20,
//! compatible with circomlib (zero leaf = 0, node = Poseidon(left, right)).
//! Keeps the last ROOT_HISTORY roots so proofs against a recent root stay
//! valid while other positions are inserted. Every leaf is also stored, so
//! clients build Merkle paths from the contract (not from events, which RPC
//! keeps only briefly).

use crate::DataKey;
use zkperp_poseidon::{u256, Params, TREE_DEPTH, ZEROS};
use soroban_sdk::{Env, Vec, U256};

pub const ROOT_HISTORY: u32 = 32;

pub fn init(env: &Env) {
    let s = env.storage().instance();
    let mut filled = Vec::new(env);
    for i in 0..TREE_DEPTH as usize {
        filled.push_back(u256(env, &ZEROS[i]));
    }
    let mut roots = Vec::new(env);
    roots.push_back(u256(env, &ZEROS[TREE_DEPTH as usize]));
    s.set(&DataKey::TreeFilled, &filled);
    s.set(&DataKey::TreeNext, &0u32);
    s.set(&DataKey::TreeRoots, &roots);
}

/// Appends `leaf` and returns (leaf index, new root). Panics if the tree is full.
pub fn insert(env: &Env, leaf: U256) -> (u32, U256) {
    let s = env.storage().instance();
    let index: u32 = s.get(&DataKey::TreeNext).unwrap();
    assert!(index < (1u32 << TREE_DEPTH), "position tree is full");
    let mut filled: Vec<U256> = s.get(&DataKey::TreeFilled).unwrap();
    let p = Params::t3(env);

    let leaf_copy = leaf.clone();
    let mut node = leaf;
    let mut i = index;
    for level in 0..TREE_DEPTH {
        node = if i & 1 == 0 {
            filled.set(level, node.clone());
            p.hash(env, &[node, u256(env, &ZEROS[level as usize])])
        } else {
            p.hash(env, &[filled.get_unchecked(level), node])
        };
        i >>= 1;
    }

    let key = DataKey::Leaf(index);
    env.storage().persistent().set(&key, &leaf_copy);
    env.storage().persistent().extend_ttl(&key, crate::TTL_THRESHOLD, crate::TTL_EXTEND_TO);

    let mut roots: Vec<U256> = s.get(&DataKey::TreeRoots).unwrap();
    if roots.len() == ROOT_HISTORY {
        roots.pop_front();
    }
    roots.push_back(node.clone());
    s.set(&DataKey::TreeFilled, &filled);
    s.set(&DataKey::TreeNext, &(index + 1));
    s.set(&DataKey::TreeRoots, &roots);
    (index, node)
}

pub fn root(env: &Env) -> U256 {
    let roots: Vec<U256> = env.storage().instance().get(&DataKey::TreeRoots).unwrap();
    roots.last_unchecked()
}

pub fn is_known_root(env: &Env, root: &U256) -> bool {
    let roots: Vec<U256> = env.storage().instance().get(&DataKey::TreeRoots).unwrap();
    roots.contains(root)
}

pub fn next_index(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::TreeNext).unwrap()
}

/// Stored leaves `start..start+count` (at most 200); an unstored leaf (one
/// inserted before leaf storage existed) is returned as 0.
pub fn leaves(env: &Env, start: u32, count: u32) -> Vec<U256> {
    let end = (start + count.min(200)).min(next_index(env));
    let mut out = Vec::new(env);
    for i in start..end {
        out.push_back(env.storage().persistent().get(&DataKey::Leaf(i)).unwrap_or(U256::from_u32(env, 0)));
    }
    out
}
