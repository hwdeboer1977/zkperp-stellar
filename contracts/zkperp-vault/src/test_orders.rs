#![cfg(test)]
//! Stop loss / take profit with real proofs (`fixtures/orders.json`, from
//! `circuits/scripts/orders-fixture.mjs`).

extern crate std;

use super::*;
use crate::test_notes::{dec, proof, s, vk};
use crate::test_oracle::{set_signed_price, signer_keys};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, Address, Env, Vec,
};

const UNIT: i128 = 10_000_000;

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/orders.json")).unwrap()
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
    vault.init_close(&vk(&env, &f["close_vk"]), &dec(&env, &f["treasury_owner"]));
    vault.set_borrow_rate(&27_778);
    let keepers = soroban_sdk::vec![&env, keeper.clone(), Address::generate(&env), Address::generate(&env)];
    vault.init_liquidation(&vk(&env, &f["liquidate_vk"]), &LiquidationConfig { keepers, maintenance_bps: 250, liquidation_fee_bps: 50 });
    vault.init_orders(&vk(&env, &f["order_auth_vk"]), &vk(&env, &f["execute_order_vk"]));

    let t0: u64 = s(&f["t0"]).parse().unwrap();
    env.ledger().set_timestamp(t0 + 10);
    set_signed_price(&vault, 1, s(&f["p1"]).parse().unwrap(), t0 + 10);
    vault.deposit_note(&trader, &(1_000 * UNIT), &dec(&env, &f["deposit"]["inner"]));
    let o = &f["open"];
    let mut note = Vec::new(&env);
    for e in o["note"].as_array().unwrap() {
        note.push_back(dec(&env, e));
    }
    vault.open_position_private(&dec(&env, &o["root"]), &dec(&env, &o["nullifier"]), &dec(&env, &o["commitment"]), &dec(&env, &o["change"]),
        &KeeperKey { x: dec(&env, &o["note_r"][0]), y: dec(&env, &o["note_r"][1]) }, &note, &t0, &proof(&env, &o["proof"]));
    T { vault, env, keeper }
}

fn auth(t: &T, which: &str, cancel: bool) -> Result<(), Error> {
    let a = &fx()[which];
    let env = &t.env;
    let mut note = Vec::new(env);
    for e in a["note"].as_array().unwrap() {
        note.push_back(dec(env, e));
    }
    let args = (dec(env, &a["root"]), dec(env, &a["order_id"]), KeeperKey { x: dec(env, &a["note_r"][0]), y: dec(env, &a["note_r"][1]) }, note, proof(env, &a["proof"]));
    let r = if cancel {
        t.vault.try_cancel_order(&args.0, &args.1, &args.2, &args.3, &args.4)
    } else {
        t.vault.try_place_order(&args.0, &args.1, &args.2, &args.3, &args.4)
    };
    match r {
        Ok(Ok(())) => Ok(()),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn execute(t: &T, keeper: &Address) -> Result<u32, Error> {
    let e = &fx()["execute"];
    let env = &t.env;
    match t.vault.try_execute_order(keeper, &dec(env, &e["order_id"]), &dec(env, &e["root"]), &dec(env, &e["nullifier"]), &dec(env, &e["payout"]),
        &dec(env, &e["fee"]), &s(&e["pool_in"]).parse().unwrap(), &s(&e["pool_out"]).parse().unwrap(), &s(&e["close_time"]).parse().unwrap(), &proof(env, &e["proof"])) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(err)) => Err(err),
        other => panic!("unexpected {other:?}"),
    }
}

/// Price falls through the stop (79,000) to P2 = 78,500.
fn crash(t: &T) {
    let t0: u64 = s(&fx()["t0"]).parse().unwrap();
    t.env.ledger().set_timestamp(t0 + 600);
    set_signed_price(&t.vault, 2, s(&fx()["p2"]).parse().unwrap(), t0 + 590);
}

#[test]
fn place_cancel_and_execute_a_stop_loss() {
    let t = setup();
    let f = fx();
    t.env.set_auths(&[]);
    assert_eq!(auth(&t, "place_sl", false), Ok(()), "placing needs no signature");
    assert_eq!(auth(&t, "place_tp", false), Ok(()));
    assert!(t.vault.is_order_open(&dec(&t.env, &f["place_tp"]["order_id"])));
    assert_eq!(auth(&t, "cancel_tp", true), Ok(()));
    assert!(!t.vault.is_order_open(&dec(&t.env, &f["place_tp"]["order_id"])));

    t.env.mock_all_auths();
    crash(&t);
    let pool = t.vault.pool_value();
    assert_eq!(execute(&t, &t.keeper), Ok(3));
    let e = &f["execute"];
    let pool_in: i128 = s(&e["pool_in"]).parse().unwrap();
    assert_eq!(t.vault.pool_value(), pool + pool_in, "the stop loss's loss went to the pool");
    assert_eq!(t.vault.live_positions(), 0);
    assert!(!t.vault.is_order_open(&dec(&t.env, &e["order_id"])));
    let rec = t.vault.order_execution(&dec(&t.env, &e["nullifier"])).unwrap();
    assert_eq!((rec.payout_leaf, rec.exit_price), (3, s(&f["p2"]).parse().unwrap()));
    let _ = t.env.events().all();
}

#[test]
fn orders_cant_be_replayed_or_double_used() {
    let t = setup();
    auth(&t, "place_sl", false).unwrap();
    assert_eq!(auth(&t, "place_sl", false), Err(Error::OrderExists));
    assert_eq!(auth(&t, "cancel_tp", true), Err(Error::NoSuchOrder), "the TP was never placed");
    crash(&t);
    execute(&t, &t.keeper).unwrap();
    assert_eq!(execute(&t, &t.keeper), Err(Error::NoSuchOrder), "executed orders are gone");
}

#[test]
fn only_keepers_execute_and_only_crossed_orders() {
    let t = setup();
    auth(&t, "place_sl", false).unwrap();
    // Not crossed yet: the price is still P1, so the proof (made at P2) fails.
    let t0: u64 = s(&fx()["t0"]).parse().unwrap();
    t.env.ledger().set_timestamp(t0 + 600);
    assert_eq!(execute(&t, &t.keeper), Err(Error::InvalidProof));
    crash(&t);
    assert_eq!(execute(&t, &Address::generate(&t.env)), Err(Error::NotAKeeper));
}

#[test]
fn a_cancelled_order_cant_execute() {
    let t = setup();
    auth(&t, "place_sl", false).unwrap();
    crash(&t);
    // A cancel proof for the SL would remove it; here we check a removed order: place TP, cancel, then try executing TP's id.
    auth(&t, "place_tp", false).unwrap();
    auth(&t, "cancel_tp", true).unwrap();
    assert!(!t.vault.is_order_open(&dec(&t.env, &fx()["place_tp"]["order_id"])));
}
