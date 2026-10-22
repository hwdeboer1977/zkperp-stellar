#![cfg(test)]
//! Limit orders with real proofs (`fixtures/limits.json`, from
//! `circuits/scripts/limits-fixture.mjs`).

extern crate std;

use super::*;
use crate::test_notes::{dec, proof, s, vk};
use crate::test_oracle::{set_signed_price, signer_keys};
use soroban_sdk::{testutils::{Address as _, Ledger as _}, token, Address, Env, Vec};

const UNIT: i128 = 10_000_000;

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/limits.json")).unwrap()
}

struct T<'a> {
    env: Env,
    vault: ZkPerpVaultClient<'a>,
    keeper: Address,
}

fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let f = fx();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let id = env.register(ZkPerpVault, (Address::generate(&env), &sac, 5_000 * UNIT));
    let vault = ZkPerpVaultClient::new(&env, &id);
    let mint = token::StellarAssetClient::new(&env, &sac);
    let (lp, trader, keeper) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    mint.mint(&lp, &(20_000 * UNIT));
    mint.mint(&trader, &(1_000 * UNIT));
    vault.deposit(&lp, &(20_000 * UNIT));
    let open_vk: serde_json::Value = serde_json::from_str(include_str!("fixtures/open.json")).unwrap();
    vault.init_perp(
        &PerpConfig { signers: signer_keys(&env), keeper_key: KeeperKey { x: dec(&env, &f["keeper_pk"][0]), y: dec(&env, &f["keeper_pk"][1]) }, fee_bps: 10, max_price_age: 3600 },
        &vk(&env, &open_vk["vk"]),
    );
    vault.init_notes(&vk(&env, &f["open_private_vk"]), &vk(&env, &f["withdraw_vk"]));
    vault.init_close(&vk(&env, &f["close_vk"]), &soroban_sdk::U256::from_u32(&env, 7));
    let keepers = soroban_sdk::vec![&env, keeper.clone(), Address::generate(&env), Address::generate(&env)];
    vault.init_liquidation(&vk(&env, &f["liquidate_vk"]), &LiquidationConfig { keepers, maintenance_bps: 250, liquidation_fee_bps: 50 });
    vault.init_limits(&vk(&env, &f["place_vk"]), &vk(&env, &f["execute_vk"]), &vk(&env, &f["cancel_vk"]));
    let t0: u64 = s(&f["t0"]).parse().unwrap();
    env.ledger().set_timestamp(t0 + 10);
    set_signed_price(&vault, 1, 82_000 * UNIT, t0 + 10);
    vault.deposit_note(&trader, &(1_000 * UNIT), &dec(&env, &f["deposit"]["inner"]));
    T { vault, env, keeper }
}

fn place(t: &T, which: &str) -> Result<u32, Error> {
    let p = &fx()[which];
    let env = &t.env;
    let mut note = Vec::new(env);
    for e in p["note"].as_array().unwrap() {
        note.push_back(dec(env, e));
    }
    match t.vault.try_place_limit(&dec(env, &p["root"]), &dec(env, &p["nullifier"]), &dec(env, &p["order"]), &dec(env, &p["change"]),
        &KeeperKey { x: dec(env, &p["note_r"][0]), y: dec(env, &p["note_r"][1]) }, &note, &proof(env, &p["proof"])) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn fill(t: &T, keeper: &Address) -> Result<u32, Error> {
    let x = &fx()["fill"];
    let env = &t.env;
    match t.vault.try_execute_limit(keeper, &dec(env, &x["order"]), &dec(env, &x["commitment"]), &s(&x["open_time"]).parse().unwrap(), &proof(env, &x["proof"])) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn cancel(t: &T) -> Result<u32, Error> {
    let c = &fx()["cancel"];
    let env = &t.env;
    match t.vault.try_cancel_limit(&dec(env, &c["order"]), &dec(env, &c["refund"]), &proof(env, &c["proof"])) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn price_to_fill(t: &T) {
    let t0: u64 = s(&fx()["t0"]).parse().unwrap();
    t.env.ledger().set_timestamp(t0 + 600);
    set_signed_price(&t.vault, 2, s(&fx()["fill_price"]).parse().unwrap(), t0 + 590);
}

#[test]
fn place_fill_and_cancel() {
    let t = setup();
    let funds = t.vault.trader_funds();
    t.env.set_auths(&[]);
    assert_eq!(place(&t, "place_a"), Ok(1), "no signature; change at leaf 1");
    assert_eq!(place(&t, "place_b"), Ok(2));
    assert_eq!(t.vault.trader_funds(), funds, "escrow stays in trader funds");
    t.env.mock_all_auths();
    price_to_fill(&t);
    assert_eq!(t.vault.live_positions(), 0);
    assert_eq!(fill(&t, &t.keeper), Ok(3));
    assert_eq!(t.vault.live_positions(), 1, "the filled order is a live position");
    let rec = t.vault.limit_fill(&dec(&t.env, &fx()["fill"]["order"])).unwrap();
    assert_eq!((rec.leaf_index, rec.entry_price), (3, s(&fx()["fill_price"]).parse().unwrap()));
    t.env.set_auths(&[]);
    assert_eq!(cancel(&t), Ok(4), "owner's cancel, no signature; refund at leaf 4");
    assert_eq!(t.vault.trader_funds(), funds);
}

#[test]
fn fill_needs_the_limit_reached_a_keeper_and_happens_once() {
    let t = setup();
    place(&t, "place_a").unwrap();
    let t0: u64 = s(&fx()["t0"]).parse().unwrap();
    t.env.ledger().set_timestamp(t0 + 600);
    assert_eq!(fill(&t, &t.keeper), Err(Error::InvalidProof), "price is still 82,000 (proof made at 79,800)");
    price_to_fill(&t);
    assert_eq!(fill(&t, &Address::generate(&t.env)), Err(Error::NotAKeeper));
    fill(&t, &t.keeper).unwrap();
    assert_eq!(fill(&t, &t.keeper), Err(Error::NoSuchOrder));
}

#[test]
fn orders_cant_be_double_placed_or_cancelled_after_fill() {
    let t = setup();
    place(&t, "place_a").unwrap();
    assert_eq!(place(&t, "place_a"), Err(Error::OrderExists));
    assert_eq!(cancel(&t), Err(Error::NoSuchOrder), "B was never placed");
    place(&t, "place_b").unwrap();
    cancel(&t).unwrap();
    assert_eq!(cancel(&t), Err(Error::NoSuchOrder), "already cancelled");
}
