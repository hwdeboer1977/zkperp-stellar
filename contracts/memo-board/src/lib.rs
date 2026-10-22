#![no_std]
//! Memo board: an append-only list of encrypted blobs in contract storage.
//!
//! Traders' browsers post an encrypted copy of each private record (note,
//! position, order, limit order) here, through the relayer, before the action
//! that creates it. With only their wallet account and password, any computer
//! then scans the board, decrypts its own memos (AES-GCM: other people's fail
//! the tag check) and rebuilds the portfolio, as Midnight does with its
//! on-chain notes. Storage, not events: testnet RPC keeps events for about a
//! day, storage for as long as its rent is paid.
//!
//! The board learns nothing: no owner, no type (fixed-size padding), and the
//! relayer posts every memo. Anyone may post; a stray or junk memo only costs
//! scanners one failed decryption.

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Bytes, Env, Symbol, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    TooLarge = 1,
    Empty = 2,
}

/// Largest memo (bytes). Browsers pad memos to 512 bytes and split larger records.
pub const MAX_MEMO: u32 = 1024;
/// Most memos returned by one `get` call.
pub const MAX_PAGE: u32 = 50;
const COUNT: Symbol = symbol_short!("COUNT");

#[contract]
pub struct MemoBoard;

#[contractimpl]
impl MemoBoard {
    /// Appends `data`; returns its index.
    pub fn post(env: Env, data: Bytes) -> Result<u32, Error> {
        if data.is_empty() {
            return Err(Error::Empty);
        }
        if data.len() > MAX_MEMO {
            return Err(Error::TooLarge);
        }
        let index = Self::count(env.clone());
        let storage = env.storage().persistent();
        storage.set(&index, &data);
        let ttl = env.storage().max_ttl();
        storage.extend_ttl(&index, ttl, ttl);
        env.storage().instance().set(&COUNT, &(index + 1));
        env.storage().instance().extend_ttl(ttl, ttl);
        Ok(index)
    }

    pub fn count(env: Env) -> u32 {
        env.storage().instance().get(&COUNT).unwrap_or(0)
    }

    /// Up to `MAX_PAGE` memos from `start` (fewer at the end of the board).
    pub fn get(env: Env, start: u32, n: u32) -> Vec<Bytes> {
        let end = Self::count(env.clone()).min(start.saturating_add(n.min(MAX_PAGE)));
        let mut out = Vec::new(&env);
        for i in start..end {
            out.push_back(env.storage().persistent().get(&i).unwrap());
        }
        out
    }
}

mod test;
