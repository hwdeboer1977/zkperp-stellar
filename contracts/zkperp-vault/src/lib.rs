#![no_std]
//! ZKPerp vault: the GMX-style liquidity pool, and the one place ZKPerp holds
//! collateral tokens (mUSDC on testnet).
//!
//! LPs deposit the collateral token and get zLP shares. The pool is the
//! counterparty to every trade: it pays trader profits and keeps trader losses.
//!
//! Solvency, as in zkperp-midnight: every position's profit is capped at one
//! public constant, `max_payout`, and every open position reserves exactly
//! that much, whatever its real size. Reserved liquidity is
//! `live_positions × max_payout`, which says nothing about any position.
//! Invariant: `pool_value > live_positions × max_payout`. An LP withdrawal that
//! would break it is refused; an idle pool (no live positions) may be emptied.
//!
//! The pool's value is tracked here, not read from the token balance, so
//! tokens sent to the vault directly don't change the share price (no
//! first-depositor inflation attack). Shares and payouts round down, in the
//! pool's favour. zLP shares are balances in this contract, not a token.
//!
//! Trading lives in `perp.rs` (opening positions) and `merkle.rs` (the
//! position commitment tree).

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env, Vec, U256,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Amount or share count is zero or negative.
    InvalidAmount = 1,
    /// The deposit is too small to mint a single share.
    DepositTooSmall = 2,
    /// The LP holds fewer shares than it tries to redeem.
    InsufficientShares = 3,
    /// The shares are worth less than one token unit.
    WithdrawalTooSmall = 4,
    /// That liquidity backs open positions' maximum profit.
    LiquidityReserved = 5,
    /// An intermediate product exceeds i128.
    Overflow = 6,
    InvalidConfig = 7,
    /// Shares exist but the pool is worth nothing (traders won it all).
    PoolEmpty = 8,
    PerpNotInitialized = 9,
    PerpAlreadyInitialized = 10,
    NoPrice = 11,
    StalePrice = 12,
    InvalidPrice = 13,
    /// `open_time` is in the future or more than CLOCK_SLACK old.
    BadOpenTime = 14,
    /// The pool can't back another position's max_payout.
    NoRoomForPosition = 15,
    /// A public input is not a canonical field element (>= r).
    NotInField = 16,
    InvalidProof = 17,
    InvalidNote = 18,
    /// Signer slots must be two different slots, in order, below 3.
    InvalidSignerSlots = 19,
    /// The price round is not newer than the current one.
    StaleRound = 20,
    /// The price time is in the future, or older than the current price's.
    PriceTimeInvalid = 21,
    /// This note (nullifier) was already spent.
    NoteSpent = 22,
    /// The proof's Merkle root is not one of the recent roots.
    UnknownRoot = 23,
    NotesNotInitialized = 24,
    NotesAlreadyInitialized = 25,
    CloseNotInitialized = 26,
    CloseAlreadyInitialized = 27,
    /// `close_time` is in the future or more than CLOCK_SLACK old.
    BadCloseTime = 28,
    LiquidationNotInitialized = 29,
    LiquidationAlreadyInitialized = 30,
    /// The caller is not a registered keeper.
    NotAKeeper = 31,
    TreasuryNotInitialized = 32,
    TreasuryAlreadyInitialized = 33,
    OrdersNotInitialized = 34,
    OrdersAlreadyInitialized = 35,
    NoSuchOrder = 36,
    OrderExists = 37,
    LimitsNotInitialized = 38,
    LimitsAlreadyInitialized = 39,
}

#[contracttype]
#[derive(Clone)]
pub(crate) enum DataKey {
    Admin,
    Token,
    MaxPayout,
    PoolValue,
    TotalShares,
    LivePositions,
    Shares(Address),
    // Trading (perp.rs, merkle.rs)
    Perp,
    Mark,
    OpenVk,
    CollateralHeld,
    TreeFilled,
    TreeNext,
    TreeRoots,
    SignerEpoch,
    BorrowRate,
    // Shielded collateral (notes.rs)
    OpenPrivateVk,
    WithdrawVk,
    Nullifier(U256),
    Leaf(u32),
    // Closing (close.rs)
    CloseVk,
    TreasuryOwner,
    // Liquidation (liquidate.rs)
    LiquidateVk,
    LiquidationConfig,
    Liquidated(U256),
    // Treasury (treasury.rs)
    MergeVk,
    KeeperShareBps,
    KeeperOwed(Address),
    KeeperOwedTotal,
    // Trigger orders (orders.rs)
    OrderAuthVk,
    ExecuteOrderVk,
    Order(U256),
    OrderExecuted(U256),
    // Limit orders (limits.rs)
    PlaceLimitVk,
    ExecuteLimitVk,
    CancelLimitVk,
    LimitOrder(U256),
    LimitFill(U256),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposit {
    #[topic]
    pub lp: Address,
    pub amount: i128,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdraw {
    #[topic]
    pub lp: Address,
    pub shares: i128,
    pub amount: i128,
}

// About 5 s per ledger: extend to ~31 days whenever less than ~15 days remain.
pub(crate) const TTL_THRESHOLD: u32 = 259_200;
pub(crate) const TTL_EXTEND_TO: u32 = 535_680;

#[contract]
pub struct ZkPerpVault;

#[contractimpl]
impl ZkPerpVault {
    /// `token` is the collateral SAC (mUSDC now, Circle USDC later).
    /// `max_payout` is the most any position can win, in token units.
    pub fn __constructor(env: Env, admin: Address, token: Address, max_payout: i128) -> Result<(), Error> {
        if max_payout <= 0 {
            return Err(Error::InvalidConfig);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Token, &token);
        s.set(&DataKey::MaxPayout, &max_payout);
        s.set(&DataKey::PoolValue, &0i128);
        s.set(&DataKey::TotalShares, &0i128);
        s.set(&DataKey::LivePositions, &0u32);
        Ok(())
    }

    /// Deposits `amount` collateral from `lp` and mints zLP shares:
    /// `amount` for the first deposit, else `floor(amount × supply / value)`.
    pub fn deposit(env: Env, lp: Address, amount: i128) -> Result<i128, Error> {
        lp.require_auth();
        let shares = Self::preview_deposit(env.clone(), amount)?;
        token::Client::new(&env, &Self::token(env.clone())).transfer(&lp, &env.current_contract_address(), &amount);

        let value = Self::pool_value(env.clone()).checked_add(amount).ok_or(Error::Overflow)?;
        let supply = Self::total_shares(env.clone()).checked_add(shares).ok_or(Error::Overflow)?;
        let held = Self::shares_of(env.clone(), lp.clone()) + shares;
        put_totals(&env, value, supply);
        put_shares(&env, &lp, held);
        Deposit { lp, amount, shares }.publish(&env);
        Ok(shares)
    }

    /// Redeems `shares` of `lp` for `floor(shares × value / supply)`
    /// collateral. Refused if the pool could then no longer back every open
    /// position's maximum profit.
    pub fn withdraw(env: Env, lp: Address, shares: i128) -> Result<i128, Error> {
        lp.require_auth();
        let held = Self::shares_of(env.clone(), lp.clone());
        if shares > held {
            return Err(Error::InsufficientShares);
        }
        let amount = Self::preview_withdraw(env.clone(), shares)?;
        let value = Self::pool_value(env.clone()) - amount;
        let reserved = Self::reserved(env.clone())?;
        if reserved > 0 && value <= reserved {
            return Err(Error::LiquidityReserved);
        }

        put_totals(&env, value, Self::total_shares(env.clone()) - shares);
        put_shares(&env, &lp, held - shares);
        token::Client::new(&env, &Self::token(env.clone())).transfer(&env.current_contract_address(), &lp, &amount);
        Withdraw { lp, shares, amount }.publish(&env);
        Ok(amount)
    }

    /// Shares a deposit of `amount` would mint now.
    pub fn preview_deposit(env: Env, amount: i128) -> Result<i128, Error> {
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let (value, supply) = (Self::pool_value(env.clone()), Self::total_shares(env));
        let shares = if supply == 0 {
            amount
        } else if value == 0 {
            return Err(Error::PoolEmpty);
        } else {
            mul_div_floor(amount, supply, value)?
        };
        if shares == 0 {
            return Err(Error::DepositTooSmall);
        }
        Ok(shares)
    }

    /// Collateral that redeeming `shares` would pay now (ignores reservations).
    pub fn preview_withdraw(env: Env, shares: i128) -> Result<i128, Error> {
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }
        let (value, supply) = (Self::pool_value(env.clone()), Self::total_shares(env));
        if shares > supply {
            return Err(Error::InsufficientShares);
        }
        let amount = mul_div_floor(shares, value, supply)?;
        if amount == 0 {
            return Err(Error::WithdrawalTooSmall);
        }
        Ok(amount)
    }

    /// Liquidity LPs can take out now: everything when no position is open,
    /// else `pool_value − reserved − 1`.
    pub fn withdrawable(env: Env) -> Result<i128, Error> {
        let reserved = Self::reserved(env.clone())?;
        let value = Self::pool_value(env);
        Ok(if reserved == 0 { value } else { (value - reserved - 1).max(0) })
    }

    /// Liquidity backing open positions: `live_positions × max_payout`.
    pub fn reserved(env: Env) -> Result<i128, Error> {
        (Self::live_positions(env.clone()) as i128).checked_mul(Self::max_payout(env)).ok_or(Error::Overflow)
    }

    pub fn shares_of(env: Env, lp: Address) -> i128 {
        let key = DataKey::Shares(lp);
        let shares = env.storage().persistent().get(&key).unwrap_or(0);
        if shares > 0 {
            env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        shares
    }

    pub fn pool_value(env: Env) -> i128 {
        get_instance(&env, &DataKey::PoolValue)
    }

    pub fn total_shares(env: Env) -> i128 {
        get_instance(&env, &DataKey::TotalShares)
    }

    pub fn live_positions(env: Env) -> u32 {
        get_instance(&env, &DataKey::LivePositions)
    }

    pub fn max_payout(env: Env) -> i128 {
        get_instance(&env, &DataKey::MaxPayout)
    }

    pub fn token(env: Env) -> Address {
        get_instance(&env, &DataKey::Token)
    }

    pub fn admin(env: Env) -> Address {
        get_instance(&env, &DataKey::Admin)
    }

    /// Stored commitment-tree leaves `start..start+count` (max 200), for
    /// clients to build Merkle paths. Leaves inserted before leaf storage
    /// existed read as 0 until `backfill_leaves`.
    pub fn leaves(env: Env, start: u32, count: u32) -> Vec<U256> {
        merkle::leaves(&env, start, count)
    }

    /// Stores leaves that were inserted before leaf storage existed (vaults
    /// upgraded from step 4/5). Admin only; only fills indices that are in
    /// the tree and not yet stored. Clients check the rebuilt root against
    /// `is_known_root`, so a wrong value can't move funds; it only breaks paths.
    pub fn backfill_leaves(env: Env, start: u32, leaves: Vec<U256>) {
        Self::admin(env.clone()).require_auth();
        let next = Self::position_count(env.clone());
        for (i, leaf) in leaves.iter().enumerate() {
            let index = start + i as u32;
            let key = DataKey::Leaf(index);
            if index < next && !env.storage().persistent().has(&key) {
                env.storage().persistent().set(&key, &leaf);
                env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
            }
        }
    }

    /// Replaces this contract's code, keeping its address, balances and
    /// storage. This is how the perp logic gets added during the hackathon.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::admin(env.clone()).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}

pub(crate) fn get_instance<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> V {
    let s = env.storage().instance();
    s.extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
    s.get(key).unwrap()
}

fn put_totals(env: &Env, value: i128, supply: i128) {
    let s = env.storage().instance();
    s.set(&DataKey::PoolValue, &value);
    s.set(&DataKey::TotalShares, &supply);
}

fn put_shares(env: &Env, lp: &Address, shares: i128) {
    let key = DataKey::Shares(lp.clone());
    let s = env.storage().persistent();
    if shares == 0 {
        s.remove(&key);
    } else {
        s.set(&key, &shares);
        s.extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

fn mul_div_floor(a: i128, b: i128, c: i128) -> Result<i128, Error> {
    a.checked_mul(b).ok_or(Error::Overflow).map(|p| p / c)
}

mod close;
mod limits;
mod liquidate;
mod merkle;
mod notes;
mod oracle;
mod orders;
mod perp;
mod treasury;
pub use close::*;
pub use limits::*;
pub use liquidate::*;
pub use notes::*;
pub use oracle::*;
pub use orders::*;
pub use perp::*;
pub use treasury::*;

mod test;
mod test_close;
mod test_limits;
mod test_liquidate;
mod test_notes;
mod test_oracle;
mod test_orders;
mod test_perp;
mod test_treasury;
