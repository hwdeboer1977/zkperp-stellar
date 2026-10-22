#![cfg(test)]
//! Liquidation with real proofs (`fixtures/liquidate.json`, written by
//! `circuits/scripts/liquidate-fixture.mjs`): deposit 1,000 note (leaf 0) ->
//! private 10x long 4,000 / 400 at P1 (position leaf 1, change leaf 2) ->
//! price -8% -> keeper liquidates (owner payout leaf 3, fee note leaf 4).

extern crate std;

use super::*;
use crate::test_notes::{dec, proof, s, vk};
use crate::test_oracle::{set_signed_price, signer_keys};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, Address, Env, Event as _, Vec,
};

const UNIT: i128 = 10_000_000;
const MAX_PAYOUT: i128 = 5_000 * UNIT;
const LIQUIDITY: i128 = 20_000 * UNIT;

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/liquidate.json")).unwrap()
}

struct T<'a> {
    env: Env,
    vault: ZkPerpVaultClient<'a>,
    token: token::Client<'a>,
    keeper: Address,
}

/// Vault with the position open at P1; clock at t0 + 600, P2 (-8%) signed at t0 + 590.
fn setup<'a>(wasm: Option<&[u8]>) -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let f = fx();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let args = (Address::generate(&env), &sac, MAX_PAYOUT);
    let id = match wasm {
        Some(w) => env.register(w, args),
        None => env.register(ZkPerpVault, args),
    };
    let vault = ZkPerpVaultClient::new(&env, &id);
    let mint = token::StellarAssetClient::new(&env, &sac);
    let (lp, trader, keeper) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
    mint.mint(&lp, &LIQUIDITY);
    mint.mint(&trader, &(1_000 * UNIT));
    vault.deposit(&lp, &LIQUIDITY);

    let open_vk: serde_json::Value = serde_json::from_str(include_str!("fixtures/open.json")).unwrap();
    vault.init_perp(
        &PerpConfig {
            signers: signer_keys(&env),
            keeper_key: KeeperKey { x: dec(&env, &f["keeper_pk"][0]), y: dec(&env, &f["keeper_pk"][1]) },
            fee_bps: 10,
            max_price_age: 3600,
        },
        &vk(&env, &open_vk["vk"]),
    );
    vault.init_notes(&vk(&env, &f["open_private_vk"]), &vk(&env, &f["withdraw_vk"]));
    vault.init_close(&vk(&env, &f["close_vk"]), &dec(&env, &f["treasury_owner"]));
    let keepers = soroban_sdk::vec![&env, keeper.clone(), Address::generate(&env), Address::generate(&env)];
    vault.init_liquidation(&vk(&env, &f["liquidate_vk"]), &LiquidationConfig { keepers, maintenance_bps: 250, liquidation_fee_bps: 50 });
    vault.set_borrow_rate(&(f["borrow_rate"].as_u64().unwrap() as u32));

    let t0: u64 = s(&f["t0"]).parse().unwrap();
    env.ledger().set_timestamp(t0 + 10);
    set_signed_price(&vault, 1, s(&f["p1"]).parse().unwrap(), t0 + 10);
    vault.deposit_note(&trader, &(1_000 * UNIT), &dec(&env, &f["deposit"]["inner"]));
    let o = &f["open"];
    let mut note = Vec::new(&env);
    for e in o["note"].as_array().unwrap() {
        note.push_back(dec(&env, e));
    }
    vault.open_position_private(
        &dec(&env, &o["root"]), &dec(&env, &o["nullifier"]), &dec(&env, &o["commitment"]), &dec(&env, &o["change"]),
        &KeeperKey { x: dec(&env, &o["note_r"][0]), y: dec(&env, &o["note_r"][1]) }, &note, &t0, &proof(&env, &o["proof"]),
    );
    env.ledger().set_timestamp(t0 + 600);
    set_signed_price(&vault, 2, s(&f["p2"]).parse().unwrap(), t0 + 590);
    T { token: token::Client::new(&env, &sac), vault, env, keeper }
}

fn liquidate(t: &T, keeper: &Address, pool_in: i128) -> Result<u32, Error> {
    let l = &fx()["liquidate"];
    let env = &t.env;
    match t.vault.try_liquidate(
        keeper,
        &dec(env, &l["root"]),
        &dec(env, &l["nullifier"]),
        &dec(env, &l["payout"]),
        &dec(env, &l["fee"]),
        &pool_in,
        &s(&l["liq_time"]).parse().unwrap(),
        &proof(env, &l["proof"]),
    ) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn pool_in() -> i128 {
    s(&fx()["liquidate"]["pool_in"]).parse().unwrap()
}

#[test]
fn keeper_liquidates_below_maintenance() {
    let t = setup(None);
    assert_eq!(pool_in(), 320 * UNIT, "-8% on a 4,000 long");
    let tokens = t.token.balance(&t.vault.address);

    assert_eq!(liquidate(&t, &t.keeper, pool_in()), Ok(3));
    let last = t.env.events().all().filter_by_contract(&t.vault.address).events().last().unwrap().clone();
    assert_eq!(t.env.auths()[0].0, t.keeper, "the keeper signed");
    let l = &fx()["liquidate"];
    let p2: i128 = s(&fx()["p2"]).parse().unwrap();
    let ev = PositionLiquidated {
        nullifier: dec(&t.env, &l["nullifier"]),
        keeper: t.keeper.clone(),
        exit_price: p2,
        pool_in: pool_in(),
        payout_leaf: 3,
        payout_commitment: dec(&t.env, &l["payout"]),
        fee_leaf: 4,
        fee_commitment: dec(&t.env, &l["fee"]),
        root: t.vault.merkle_root(),
        time: s(&l["liq_time"]).parse().unwrap(),
        borrow_rate: fx()["borrow_rate"].as_u64().unwrap() as u32,
    };
    assert_eq!(last, ev.to_xdr(&t.env, &t.vault.address));

    assert_eq!(t.vault.live_positions(), 0);
    assert_eq!(t.vault.pool_value(), LIQUIDITY + 320 * UNIT, "the loss went to the pool");
    assert_eq!(t.vault.trader_funds(), 1_000 * UNIT - 320 * UNIT);
    assert_eq!(t.token.balance(&t.vault.address), tokens, "no token moved");
    let rec = t.vault.liquidation(&dec(&t.env, &l["nullifier"])).unwrap();
    assert_eq!(rec, LiquidationRecord { exit_price: p2, payout_leaf: 3, time: s(&l["liq_time"]).parse().unwrap() });
}

#[test]
fn only_registered_keepers_and_only_once() {
    let t = setup(None);
    let stranger = Address::generate(&t.env);
    assert_eq!(liquidate(&t, &stranger, pool_in()), Err(Error::NotAKeeper));
    liquidate(&t, &t.keeper, pool_in()).unwrap();
    assert_eq!(liquidate(&t, &t.keeper, pool_in()), Err(Error::NoteSpent), "already liquidated");
}

#[test]
fn keeper_must_sign() {
    let t = setup(None);
    t.env.set_auths(&[]);
    let l = &fx()["liquidate"];
    let r = t.vault.try_liquidate(&t.keeper, &dec(&t.env, &l["root"]), &dec(&t.env, &l["nullifier"]), &dec(&t.env, &l["payout"]),
        &dec(&t.env, &l["fee"]), &pool_in(), &s(&l["liq_time"]).parse().unwrap(), &proof(&t.env, &l["proof"]));
    assert!(r.is_err());
}

#[test]
fn liquidation_needs_the_crashed_price() {
    let t = setup(None);
    // Price recovers before the keeper lands its proof: the proof no longer matches.
    let p1: i128 = s(&fx()["p1"]).parse().unwrap();
    let t0: u64 = s(&fx()["t0"]).parse().unwrap();
    set_signed_price(&t.vault, 3, p1, t0 + 595);
    assert_eq!(liquidate(&t, &t.keeper, pool_in()), Err(Error::InvalidProof));
}

#[test]
fn misstated_loss_is_rejected() {
    let t = setup(None);
    assert_eq!(liquidate(&t, &t.keeper, pool_in() - 1), Err(Error::InvalidProof));
}

#[test]
fn liquidation_admin() {
    let t = setup(None);
    let f = fx();
    let cfg = t.vault.liquidation_config();
    assert_eq!((cfg.maintenance_bps, cfg.liquidation_fee_bps, cfg.keepers.len()), (250, 50, 3));
    assert_eq!(t.vault.try_init_liquidation(&vk(&t.env, &f["liquidate_vk"]), &cfg), Err(Ok(Error::LiquidationAlreadyInitialized)));
    let bad = LiquidationConfig { keepers: Vec::new(&t.env), ..cfg.clone() };
    assert_eq!(t.vault.try_set_liquidation_config(&vk(&t.env, &f["liquidate_vk"]), &bad), Err(Ok(Error::InvalidConfig)));
    t.env.set_auths(&[]);
    assert!(t.vault.try_set_liquidation_config(&vk(&t.env, &f["liquidate_vk"]), &cfg).is_err(), "admin only");
}

/// Cost as compiled WASM. Build first; skipped if the .wasm is missing.
#[test]
fn wasm_liquidate_cost() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/wasm32v1-none/release/zkperp_vault.wasm");
    let Ok(wasm) = std::fs::read(path) else {
        std::println!("skipping wasm_liquidate_cost: {path} not found");
        return;
    };
    let t = setup(Some(&wasm));
    t.env.cost_estimate().budget().reset_unlimited();
    liquidate(&t, &t.keeper, pool_in()).unwrap();
    let cpu = t.env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("wasm liquidate: cpu_insns={cpu} ({:.1}% of 400M tx limit)", cpu as f64 / 4e6);
}
