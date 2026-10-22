#![cfg(test)]
//! Opening positions, with a real Groth16 proof made by snarkjs from
//! `circuits/open_position.circom` (`fixtures/open.json`, written by
//! `circuits/scripts/fixture.mjs`).

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, vec, Address, Bytes, BytesN, Env, Event as _, Vec, U256,
};
use crate::test_oracle::set_signed_price;
use groth16::{Proof, VerificationKey};

const UNIT: i128 = 10_000_000;
const MAX_PAYOUT: i128 = 5_000 * UNIT;

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/open.json")).unwrap()
}

fn bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
    let mut b = [0u8; N];
    for i in 0..N {
        b[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(env, &b)
}

fn u256(env: &Env, hex: &str) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &bytes::<32>(env, hex).to_array()))
}

fn s(v: &serde_json::Value) -> &str {
    v.as_str().unwrap()
}

fn num(v: &serde_json::Value) -> i128 {
    s(v).parse().unwrap()
}

struct Open {
    collateral: i128,
    price: i128,
    open_time: u64,
    commitment: U256,
    note_r: KeeperKey,
    note: Vec<U256>,
    proof: Proof,
}

fn open_args(env: &Env) -> Open {
    let f = fx();
    let mut note = Vec::new(env);
    for e in f["note"].as_array().unwrap() {
        note.push_back(u256(env, s(e)));
    }
    Open {
        collateral: num(&f["collateral"]),
        price: num(&f["price"]),
        open_time: s(&f["open_time"]).parse().unwrap(),
        commitment: u256(env, s(&f["commitment"])),
        note_r: KeeperKey { x: u256(env, s(&f["noteR"][0])), y: u256(env, s(&f["noteR"][1])) },
        note,
        proof: Proof {
            a: bytes(env, s(&f["proof"]["a"])),
            b: bytes(env, s(&f["proof"]["b"])),
            c: bytes(env, s(&f["proof"]["c"])),
        },
    }
}

fn open_vk(env: &Env) -> VerificationKey {
    let f = fx();
    let vk = &f["vk"];
    let mut ic = Vec::new(env);
    for p in vk["ic"].as_array().unwrap() {
        ic.push_back(bytes(env, s(p)));
    }
    VerificationKey {
        alpha: bytes(env, s(&vk["alpha"])),
        beta: bytes(env, s(&vk["beta"])),
        gamma: bytes(env, s(&vk["gamma"])),
        delta: bytes(env, s(&vk["delta"])),
        ic,
    }
}

struct T<'a> {
    env: Env,
    vault: ZkPerpVaultClient<'a>,
    token: token::Client<'a>,
    mint: token::StellarAssetClient<'a>,
    trader: Address,
}

/// Vault with `liquidity` deposited, trading on, price set, clock at open_time + 10.
fn setup<'a>(liquidity: i128) -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let f = fx();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let id = env.register(ZkPerpVault, (Address::generate(&env), &sac, MAX_PAYOUT));
    let t = T {
        vault: ZkPerpVaultClient::new(&env, &id),
        token: token::Client::new(&env, &sac),
        mint: token::StellarAssetClient::new(&env, &sac),
        trader: Address::generate(&env),
        env,
    };
    let lp = Address::generate(&t.env);
    t.mint.mint(&lp, &liquidity);
    t.vault.deposit(&lp, &liquidity);
    t.mint.mint(&t.trader, &(10_000 * UNIT));

    let config = PerpConfig {
        signers: crate::test_oracle::signer_keys(&t.env),
        keeper_key: KeeperKey { x: u256(&t.env, s(&f["keeper_pk"][0])), y: u256(&t.env, s(&f["keeper_pk"][1])) },
        fee_bps: f["fee_bps"].as_u64().unwrap() as u32,
        max_price_age: 3600,
    };
    t.vault.init_perp(&config, &open_vk(&t.env));
    let o = open_args(&t.env);
    t.env.ledger().set_timestamp(o.open_time + 10);
    set_signed_price(&t.vault, 1, o.price, o.open_time + 10);
    t
}

fn open(t: &T, o: &Open) -> Result<u32, Error> {
    match t.vault.try_open_position(&t.trader, &o.collateral, &o.open_time, &o.commitment, &o.note_r, &o.note, &o.proof) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn opens_a_position_with_a_real_proof() {
    let t = setup(20_000 * UNIT);
    let o = open_args(&t.env);
    let pool_before = t.vault.pool_value();

    assert_eq!(open(&t, &o), Ok(0));
    // Events are those of the last invocation, so check them first.
    let root = u256(&t.env, s(&fx()["root_after"]));
    let ev = PositionOpened { leaf_index: 0, commitment: o.commitment.clone(), root: root.clone(), note_r: o.note_r.clone(), note: o.note.clone() };
    let events = t.env.events().all().filter_by_contract(&t.vault.address);
    assert_eq!(events.events().last().unwrap(), &ev.to_xdr(&t.env, &t.vault.address));

    assert_eq!(t.vault.live_positions(), 1);
    assert_eq!(t.vault.reserved(), MAX_PAYOUT);
    assert_eq!(t.vault.trader_funds(), o.collateral);
    assert_eq!(t.vault.pool_value(), pool_before, "collateral is not LP money");
    assert_eq!(t.token.balance(&t.vault.address), pool_before + o.collateral);
    assert_eq!(t.token.balance(&t.trader), 10_000 * UNIT - o.collateral);
    assert_eq!(t.vault.position_count(), 1);
    // Same root as circomlibjs computes for this one leaf.
    assert_eq!(t.vault.merkle_root(), root);
    assert!(t.vault.is_known_root(&root));
}

#[test]
fn price_moved_since_proving_is_rejected() {
    let t = setup(20_000 * UNIT);
    let o = open_args(&t.env);
    set_signed_price(&t.vault, 2, o.price + 1, o.open_time + 10);
    assert_eq!(open(&t, &o), Err(Error::InvalidProof));
}

#[test]
fn tampered_keeper_note_is_rejected() {
    let t = setup(20_000 * UNIT);
    let mut o = open_args(&t.env);
    o.note.set(1, U256::from_u32(&t.env, 7)); // garble the encrypted size
    assert_eq!(open(&t, &o), Err(Error::InvalidProof));
}

#[test]
fn different_collateral_than_proven_is_rejected() {
    let t = setup(20_000 * UNIT);
    let mut o = open_args(&t.env);
    o.collateral -= 1; // pay less than the proof claims
    assert_eq!(open(&t, &o), Err(Error::InvalidProof));
}

#[test]
fn non_canonical_input_is_rejected() {
    let t = setup(20_000 * UNIT);
    let mut o = open_args(&t.env);
    // commitment + r would reduce to the same field element.
    let r = U256::from_be_bytes(&t.env, &Bytes::from_array(&t.env, &zkperp_poseidon::R));
    o.commitment = o.commitment.add(&r);
    assert_eq!(open(&t, &o), Err(Error::NotInField));
}

#[test]
fn timing_and_price_freshness_are_enforced() {
    let t = setup(20_000 * UNIT);
    let o = open_args(&t.env);
    t.env.ledger().set_timestamp(o.open_time - 1);
    assert_eq!(open(&t, &o), Err(Error::BadOpenTime));
    t.env.ledger().set_timestamp(o.open_time + CLOCK_SLACK + 1);
    assert_eq!(open(&t, &o), Err(Error::BadOpenTime));
    // Price set at open_time + 10; an hour and more later it is stale.
    t.env.ledger().set_timestamp(o.open_time + 10 + 3601);
    let mut late = open_args(&t.env);
    late.open_time = o.open_time + 10 + 3601;
    assert_eq!(open(&t, &late), Err(Error::StalePrice));
}

#[test]
fn pool_must_back_max_payout() {
    // Exactly one max_payout in the pool is not enough (strict invariant).
    let t = setup(MAX_PAYOUT);
    assert_eq!(open(&t, &open_args(&t.env)), Err(Error::NoRoomForPosition));
}

#[test]
fn open_reserves_liquidity_against_lp_withdrawals() {
    let t = setup(6_000 * UNIT);
    let lp_shares = t.vault.total_shares();
    open(&t, &open_args(&t.env)).unwrap();
    assert_eq!(t.vault.withdrawable(), 1_000 * UNIT - 1);
    // The (single) LP can't pull the reserved 5,000.
    let res = t.env.as_contract(&t.vault.address, || ZkPerpVault::preview_withdraw(t.env.clone(), lp_shares));
    assert!(res.is_ok());
}

#[test]
fn init_perp_is_admin_only_and_once() {
    let t = setup(20_000 * UNIT);
    let config = t.vault.perp_config();
    assert_eq!(t.vault.try_init_perp(&config, &open_vk(&t.env)), Err(Ok(Error::PerpAlreadyInitialized)));
    t.vault.set_open_vk(&open_vk(&t.env));
    t.env.set_auths(&[]);
    assert!(t.vault.try_set_open_vk(&open_vk(&t.env)).is_err(), "set_open_vk needs the admin");
}

#[test]
fn merkle_tree_matches_circomlibjs() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();
    let v: serde_json::Value = serde_json::from_str(include_str!("../../../crates/zkperp-poseidon/src/vectors.json")).unwrap();
    let id = env.register(ZkPerpVault, (Address::generate(&env), Address::generate(&env), 1i128));
    env.as_contract(&id, || {
        merkle::init(&env);
        for case in v["merkle"].as_array().unwrap() {
            let leaf = s(case["leaves"].as_array().unwrap().last().unwrap());
            let (_, root) = merkle::insert(&env, u256(&env, leaf));
            assert_eq!(root, u256(&env, s(&case["root"])));
        }
        assert_eq!(merkle::next_index(&env), 3);
    });
    let _ = vec![&env, 1u32];
}

/// Cost of `open_position` running as the compiled WASM. Build first with
/// `stellar contract build --package zkperp-vault`; skipped if missing.
#[test]
fn wasm_open_cost() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/wasm32v1-none/release/zkperp_vault.wasm");
    let Ok(wasm) = std::fs::read(path) else {
        std::println!("skipping wasm_open_cost: {path} not found");
        return;
    };
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let f = fx();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let id = env.register(wasm.as_slice(), (Address::generate(&env), &sac, MAX_PAYOUT));
    let vault = ZkPerpVaultClient::new(&env, &id);
    let mint = token::StellarAssetClient::new(&env, &sac);
    let (lp, trader) = (Address::generate(&env), Address::generate(&env));
    mint.mint(&lp, &(20_000 * UNIT));
    mint.mint(&trader, &(1_000 * UNIT));
    vault.deposit(&lp, &(20_000 * UNIT));
    let config = PerpConfig {
        signers: crate::test_oracle::signer_keys(&env),
        keeper_key: KeeperKey { x: u256(&env, s(&f["keeper_pk"][0])), y: u256(&env, s(&f["keeper_pk"][1])) },
        fee_bps: 10,
        max_price_age: 3600,
    };
    vault.init_perp(&config, &open_vk(&env));
    let o = open_args(&env);
    env.ledger().set_timestamp(o.open_time + 10);
    let d = vault.price_digest(&1, &o.price, &(o.open_time + 10));
    let (sa, sb) = (crate::test_oracle::sig(&env, 1, &d), crate::test_oracle::sig(&env, 2, &d));
    env.cost_estimate().budget().reset_unlimited();
    vault.set_price(&1, &o.price, &(o.open_time + 10), &0, &1, &sa, &sb);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("wasm set_price (2 ed25519 sigs): cpu_insns={cpu} ({:.2}% of 400M tx limit)", cpu as f64 / 4e6);

    env.cost_estimate().budget().reset_unlimited();
    vault.open_position(&trader, &o.collateral, &o.open_time, &o.commitment, &o.note_r, &o.note, &o.proof);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    std::println!("wasm open_position: cpu_insns={cpu} ({:.1}% of 400M tx limit)", cpu as f64 / 4e6);
}
