#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _},
    token, Address, Env, Event as _,
};

const UNIT: i128 = 10_000_000; // 7 decimals
const MAX_PAYOUT: i128 = 5_000 * UNIT;

struct T<'a> {
    env: Env,
    vault: ZkPerpVaultClient<'a>,
    token: token::Client<'a>,
    mint: token::StellarAssetClient<'a>,
}

fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let admin = Address::generate(&env);
    let id = env.register(ZkPerpVault, (&admin, &sac, MAX_PAYOUT));
    T {
        vault: ZkPerpVaultClient::new(&env, &id),
        token: token::Client::new(&env, &sac),
        mint: token::StellarAssetClient::new(&env, &sac),
        env,
    }
}

fn lp(t: &T, balance: i128) -> Address {
    let a = Address::generate(&t.env);
    t.mint.mint(&a, &balance);
    a
}

/// Stand-in for the perp logic that doesn't exist yet.
fn set_live_positions(t: &T, n: u32) {
    t.env.as_contract(&t.vault.address, || {
        t.env.storage().instance().set(&DataKey::LivePositions, &n);
    });
}

#[test]
fn first_deposit_mints_one_share_per_unit() {
    let t = setup();
    let a = lp(&t, 1_000 * UNIT);
    assert_eq!(t.vault.deposit(&a, &(1_000 * UNIT)), 1_000 * UNIT);
    assert_eq!(t.vault.shares_of(&a), 1_000 * UNIT);
    assert_eq!(t.vault.pool_value(), 1_000 * UNIT);
    assert_eq!(t.token.balance(&t.vault.address), 1_000 * UNIT);
    assert_eq!(t.token.balance(&a), 0);
}

#[test]
fn deposit_requires_lp_auth_and_emits_event() {
    let t = setup();
    let a = lp(&t, 10 * UNIT);
    t.vault.deposit(&a, &(10 * UNIT));
    let auths = t.env.auths();
    assert_eq!(auths[0].0, a);
    let expected = Deposit { lp: a, amount: 10 * UNIT, shares: 10 * UNIT };
    assert_eq!(
        t.env.events().all().filter_by_contract(&t.vault.address),
        [expected.to_xdr(&t.env, &t.vault.address)]
    );
}

#[test]
fn later_deposits_are_pro_rata_and_round_down() {
    let t = setup();
    let (a, b) = (lp(&t, 100 * UNIT), lp(&t, 100 * UNIT));
    t.vault.deposit(&a, &(100 * UNIT));
    // Pool gains 50 (as trader losses will later): each share is worth 1.5.
    t.env.as_contract(&t.vault.address, || {
        t.env.storage().instance().set(&DataKey::PoolValue, &(150 * UNIT));
    });
    t.mint.mint(&t.vault.address, &(50 * UNIT));
    // 10 tokens buy floor(10 * 100 / 150) shares.
    assert_eq!(t.vault.deposit(&b, &(10 * UNIT)), 10 * UNIT * 100 / 150);
}

#[test]
fn withdraw_pays_pro_rata_rounded_in_pool_favour() {
    let t = setup();
    let a = lp(&t, 3);
    t.vault.deposit(&a, &3);
    t.env.as_contract(&t.vault.address, || {
        t.env.storage().instance().set(&DataKey::PoolValue, &4i128);
    });
    t.mint.mint(&t.vault.address, &1);
    // 1 share of 3 is worth 4/3 -> pays 1, the remainder stays in the pool.
    assert_eq!(t.vault.withdraw(&a, &1), 1);
    assert_eq!(t.vault.pool_value(), 3);
    assert_eq!(t.vault.total_shares(), 2);
}

#[test]
fn last_lp_can_empty_an_idle_pool() {
    let t = setup();
    let a = lp(&t, 1_000 * UNIT);
    t.vault.deposit(&a, &(1_000 * UNIT));
    assert_eq!(t.vault.withdraw(&a, &(1_000 * UNIT)), 1_000 * UNIT);
    assert_eq!((t.vault.pool_value(), t.vault.total_shares(), t.vault.shares_of(&a)), (0, 0, 0));
    assert_eq!(t.token.balance(&a), 1_000 * UNIT);
}

#[test]
fn reserved_liquidity_cannot_leave() {
    let t = setup();
    let a = lp(&t, 20_000 * UNIT);
    t.vault.deposit(&a, &(20_000 * UNIT));
    set_live_positions(&t, 3); // reserves 15,000
    assert_eq!(t.vault.reserved(), 15_000 * UNIT);
    assert_eq!(t.vault.withdrawable(), 5_000 * UNIT - 1);
    // Leaving exactly the reserve breaks the strict invariant.
    assert_eq!(t.vault.try_withdraw(&a, &(5_000 * UNIT)), Err(Ok(Error::LiquidityReserved)));
    assert_eq!(t.vault.withdraw(&a, &(5_000 * UNIT - 1)), 5_000 * UNIT - 1);
    assert_eq!(t.vault.try_withdraw(&a, &1), Err(Ok(Error::LiquidityReserved)));
}

#[test]
fn direct_token_transfers_do_not_move_the_share_price() {
    let t = setup();
    let (attacker, victim) = (lp(&t, 1_000_001 * UNIT), lp(&t, 1_000 * UNIT));
    t.vault.deposit(&attacker, &1);
    // Classic inflation attack: donate to the vault to make 1 share huge.
    t.token.transfer(&attacker, &t.vault.address, &(1_000_000 * UNIT));
    assert_eq!(t.vault.pool_value(), 1);
    // The victim still gets one share per unit.
    assert_eq!(t.vault.deposit(&victim, &(1_000 * UNIT)), 1_000 * UNIT);
}

#[test]
fn rejects_bad_amounts() {
    let t = setup();
    let a = lp(&t, 10 * UNIT);
    assert_eq!(t.vault.try_deposit(&a, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(t.vault.try_withdraw(&a, &0), Err(Ok(Error::InvalidAmount)));
    t.vault.deposit(&a, &(10 * UNIT));
    assert_eq!(t.vault.try_withdraw(&a, &(10 * UNIT + 1)), Err(Ok(Error::InsufficientShares)));
    let stranger = Address::generate(&t.env);
    assert_eq!(t.vault.try_withdraw(&stranger, &1), Err(Ok(Error::InsufficientShares)));
}

#[test]
fn constructor_rejects_bad_max_payout() {
    let env = Env::default();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let admin = Address::generate(&env);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(ZkPerpVault, (&admin, &sac, 0i128));
    }));
    assert!(res.is_err());
}
