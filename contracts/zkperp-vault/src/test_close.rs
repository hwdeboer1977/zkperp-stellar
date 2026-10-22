#![cfg(test)]
//! Closing positions with real proofs (`fixtures/close.json`, written by
//! `circuits/scripts/close-fixture.mjs`): deposit 1,000 note (leaf 0) ->
//! private long 4,000 / 400 at P1 (position leaf 1, change leaf 2) -> price
//! +5% to P2 -> close (payout leaf 3, fee note leaf 4).

extern crate std;

use super::*;
use crate::test_notes::{dec, proof, s, vk};
use crate::test_oracle::{set_signed_price, signer_keys};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, Address, Env, Event as _, Vec, U256,
};

const UNIT: i128 = 10_000_000;
const MAX_PAYOUT: i128 = 5_000 * UNIT;
const LIQUIDITY: i128 = 20_000 * UNIT;

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/close.json")).unwrap()
}

struct T<'a> {
    env: Env,
    vault: ZkPerpVaultClient<'a>,
    token: token::Client<'a>,
}

/// Vault with liquidity, the note deposited and the private long open at P1;
/// clock moved to t0 + 600 with P2 signed at t0 + 590.
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
    let (lp, trader) = (Address::generate(&env), Address::generate(&env));
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
        &dec(&env, &o["root"]),
        &dec(&env, &o["nullifier"]),
        &dec(&env, &o["commitment"]),
        &dec(&env, &o["change"]),
        &KeeperKey { x: dec(&env, &o["note_r"][0]), y: dec(&env, &o["note_r"][1]) },
        &note,
        &t0,
        &proof(&env, &o["proof"]),
    );
    env.ledger().set_timestamp(t0 + 600);
    set_signed_price(&vault, 2, s(&f["p2"]).parse().unwrap(), t0 + 590);
    T { token: token::Client::new(&env, &sac), vault, env }
}

fn close(t: &T, pool_in: i128, pool_out: i128) -> Result<u32, Error> {
    let c = &fx()["close"];
    let env = &t.env;
    match t.vault.try_close_position(
        &dec(env, &c["root"]),
        &dec(env, &c["nullifier"]),
        &dec(env, &c["payout"]),
        &dec(env, &c["fee"]),
        &pool_in,
        &pool_out,
        &s(&c["close_time"]).parse().unwrap(),
        &proof(env, &c["proof"]),
    ) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn amounts() -> (i128, i128) {
    let c = &fx()["close"];
    (s(&c["pool_in"]).parse().unwrap(), s(&c["pool_out"]).parse().unwrap())
}

#[test]
fn closes_in_profit_and_settles_against_the_pool() {
    let t = setup(None);
    let (pin, pout) = amounts();
    assert_eq!((pin, pout), (0, 200 * UNIT), "+5% on a 4,000 long");
    let tokens = t.token.balance(&t.vault.address);
    assert_eq!(t.vault.live_positions(), 1);

    t.env.set_auths(&[]); // no signature needed
    assert_eq!(close(&t, pin, pout), Ok(3));
    // Events are those of the last invocation: capture them before any read.
    let last = t.env.events().all().filter_by_contract(&t.vault.address).events().last().unwrap().clone();
    let c = &fx()["close"];
    let ev = PositionClosed {
        nullifier: dec(&t.env, &c["nullifier"]),
        exit_price: s(&fx()["p2"]).parse().unwrap(),
        pool_in: pin,
        pool_out: pout,
        payout_leaf: 3,
        payout_commitment: dec(&t.env, &c["payout"]),
        fee_leaf: 4,
        fee_commitment: dec(&t.env, &c["fee"]),
        root: t.vault.merkle_root(),
        time: s(&c["close_time"]).parse().unwrap(),
        borrow_rate: fx()["borrow_rate"].as_u64().unwrap() as u32,
    };
    assert_eq!(last, ev.to_xdr(&t.env, &t.vault.address));

    assert_eq!(t.vault.live_positions(), 0, "max_payout reservation freed");
    assert_eq!(t.vault.reserved(), 0);
    assert_eq!(t.vault.pool_value(), LIQUIDITY - 200 * UNIT, "profit paid by the pool");
    assert_eq!(t.vault.trader_funds(), 1_000 * UNIT + 200 * UNIT, "payout + fee notes + change note");
    assert_eq!(t.token.balance(&t.vault.address), tokens, "no token moved");
    assert_eq!(t.token.balance(&t.vault.address), t.vault.pool_value() + t.vault.trader_funds());
    assert_eq!(t.vault.leaves(&0, &10).len(), 5);
    assert!(t.vault.is_spent(&dec(&t.env, &c["nullifier"])));
}

#[test]
fn a_position_closes_once() {
    let t = setup(None);
    let (pin, pout) = amounts();
    close(&t, pin, pout).unwrap();
    assert_eq!(close(&t, pin, pout), Err(Error::NoteSpent));
}

#[test]
fn misstated_pool_amounts_are_rejected() {
    let t = setup(None);
    let (pin, pout) = amounts();
    assert_eq!(close(&t, pin, pout + 1), Err(Error::InvalidProof), "claiming more profit");
    assert_eq!(close(&t, pin + 1, pout), Err(Error::InvalidProof));
    assert_eq!(close(&t, pin, MAX_PAYOUT + 1), Err(Error::InvalidAmount), "above the cap");
}

#[test]
fn price_moved_since_proving_is_rejected() {
    let t = setup(None);
    let p2: i128 = s(&fx()["p2"]).parse().unwrap();
    let t0: u64 = s(&fx()["t0"]).parse().unwrap();
    set_signed_price(&t.vault, 3, p2 + 1, t0 + 595);
    let (pin, pout) = amounts();
    assert_eq!(close(&t, pin, pout), Err(Error::InvalidProof));
}

#[test]
fn close_time_and_price_freshness() {
    let t = setup(None);
    let (pin, pout) = amounts();
    let t0: u64 = s(&fx()["t0"]).parse().unwrap();
    t.env.ledger().set_timestamp(t0 + 590 + CLOCK_SLACK + 1);
    assert_eq!(close(&t, pin, pout), Err(Error::BadCloseTime));
    t.env.ledger().set_timestamp(t0 + 589);
    assert_eq!(close(&t, pin, pout), Err(Error::BadCloseTime), "in the future");
}

#[test]
fn close_admin() {
    let t = setup(None);
    let f = fx();
    assert_eq!(t.vault.try_init_close(&vk(&t.env, &f["close_vk"]), &U256::from_u32(&t.env, 1)), Err(Ok(Error::CloseAlreadyInitialized)));
    assert_eq!(t.vault.borrow_rate(), 27_778);
    assert_eq!(t.vault.treasury_owner(), dec(&t.env, &f["treasury_owner"]));
    t.env.set_auths(&[]);
    assert!(t.vault.try_set_close_config(&vk(&t.env, &f["close_vk"]), &U256::from_u32(&t.env, 1)).is_err(), "admin only");
}

/// Cost as compiled WASM. Build first; skipped if the .wasm is missing.
#[test]
fn wasm_close_cost() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/wasm32v1-none/release/zkperp_vault.wasm");
    let Ok(wasm) = std::fs::read(path) else {
        std::println!("skipping wasm_close_cost: {path} not found");
        return;
    };
    let t = setup(Some(&wasm));
    let (pin, pout) = amounts();
    t.env.cost_estimate().budget().reset_unlimited();
    close(&t, pin, pout).unwrap();
    let cpu = t.env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("wasm close_position: cpu_insns={cpu} ({:.1}% of 400M tx limit)", cpu as f64 / 4e6);
}

#[test]
fn borrow_rate_is_bound_by_the_proof() {
    let t = setup(None);
    t.vault.set_borrow_rate(&0); // the proof was made at 27,778
    let (pin, pout) = amounts();
    assert_eq!(close(&t, pin, pout), Err(Error::InvalidProof));
    t.env.set_auths(&[]);
    assert!(t.vault.try_set_borrow_rate(&1).is_err(), "admin only");
}
