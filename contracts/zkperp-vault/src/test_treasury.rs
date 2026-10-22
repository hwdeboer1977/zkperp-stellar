#![cfg(test)]
//! Merging notes and collecting fees with real proofs
//! (`fixtures/treasury.json`, from `circuits/scripts/treasury-fixture.mjs`).

extern crate std;

use super::*;
use crate::test_notes::{dec, proof, s, vk};
use crate::test_oracle::signer_keys;
use soroban_sdk::{testutils::Address as _, token, Address, Env, U256};

const UNIT: i128 = 10_000_000;

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/treasury.json")).unwrap()
}

struct T<'a> {
    env: Env,
    vault: ZkPerpVaultClient<'a>,
    token: token::Client<'a>,
    keepers: soroban_sdk::Vec<Address>,
}

/// The vault at the fixture's address, with liquidity, notes on, three
/// keepers, 30% keeper share, and the treasury's two notes (30, 12) deposited.
fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let f = fx();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let id = env.register_at(&Address::from_str(&env, s(&f["vault"])), ZkPerpVault, (Address::generate(&env), &sac, 5_000 * UNIT));
    let vault = ZkPerpVaultClient::new(&env, &id);
    let mint = token::StellarAssetClient::new(&env, &sac);
    let (lp, payer) = (Address::generate(&env), Address::generate(&env));
    mint.mint(&lp, &(20_000 * UNIT));
    mint.mint(&payer, &(42 * UNIT));
    vault.deposit(&lp, &(20_000 * UNIT));
    let open_vk: serde_json::Value = serde_json::from_str(include_str!("fixtures/open.json")).unwrap();
    let liq: serde_json::Value = serde_json::from_str(include_str!("fixtures/liquidate.json")).unwrap();
    vault.init_perp(
        &PerpConfig { signers: signer_keys(&env), keeper_key: KeeperKey { x: U256::from_u32(&env, 1), y: U256::from_u32(&env, 2) }, fee_bps: 10, max_price_age: 3600 },
        &vk(&env, &open_vk["vk"]),
    );
    vault.init_notes(&vk(&env, &f["open_private_vk"]), &vk(&env, &f["withdraw_vk"]));
    vault.init_close(&vk(&env, &liq["close_vk"]), &U256::from_u32(&env, 7));
    let keepers = soroban_sdk::vec![&env, Address::generate(&env), Address::generate(&env), Address::generate(&env)];
    vault.init_liquidation(&vk(&env, &liq["liquidate_vk"]), &LiquidationConfig { keepers: keepers.clone(), maintenance_bps: 250, liquidation_fee_bps: 50 });
    vault.init_treasury(&vk(&env, &f["merge_vk"]), &3000);
    for n in f["notes"].as_array().unwrap() {
        vault.deposit_note(&payer, &s(&n["amount"]).parse::<i128>().unwrap(), &dec(&env, &n["inner"]));
    }
    T { token: token::Client::new(&env, &sac), vault, env, keepers }
}

fn merge(t: &T) -> Result<u32, Error> {
    let m = &fx()["merge"];
    match t.vault.try_merge_notes(&dec(&t.env, &m["root"]), &dec(&t.env, &m["nullifier_a"]), &dec(&t.env, &m["nullifier_b"]), &dec(&t.env, &m["merged"]), &proof(&t.env, &m["proof"])) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn collect(t: &T, amount: i128) -> Result<u32, Error> {
    let c = &fx()["collect"];
    match t.vault.try_collect_fees(&dec(&t.env, &c["root"]), &dec(&t.env, &c["nullifier"]), &amount, &dec(&t.env, &c["change"]), &proof(&t.env, &c["proof"])) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn merge_then_collect_pays_pool_and_keepers() {
    let t = setup();
    let pool = t.vault.pool_value();
    t.env.set_auths(&[]);
    assert_eq!(merge(&t), Ok(2), "merged 30 + 12 at leaf 2, no signature needed");
    assert_eq!(t.vault.trader_funds(), 42 * UNIT, "merging moves nothing");
    assert_eq!(collect(&t, 42 * UNIT), Ok(3));
    // 30% of 42 = 12.6 to 3 keepers = 4.2 each; 29.4 to the pool.
    for k in t.keepers.iter() {
        assert_eq!(t.vault.keeper_owed(&k), 42_000_000);
    }
    assert_eq!(t.vault.pool_value(), pool + 294_000_000);
    assert_eq!(t.vault.trader_funds(), 0);
    assert_eq!(t.vault.keeper_owed_total(), 126_000_000);
    let balance = t.token.balance(&t.vault.address);
    assert_eq!(balance, t.vault.pool_value() + t.vault.trader_funds() + t.vault.keeper_owed_total());
}

#[test]
fn keepers_claim_their_share() {
    let t = setup();
    merge(&t).unwrap();
    collect(&t, 42 * UNIT).unwrap();
    let k = t.keepers.get(0).unwrap();
    assert_eq!(t.vault.claim_keeper_fees(&k), 42_000_000);
    assert_eq!(t.token.balance(&k), 42_000_000);
    assert_eq!(t.vault.keeper_owed(&k), 0);
    assert_eq!(t.vault.try_claim_keeper_fees(&k), Err(Ok(Error::InvalidAmount)), "nothing left");
    assert_eq!(t.vault.keeper_owed_total(), 84_000_000);
}

#[test]
fn notes_merge_and_collect_once() {
    let t = setup();
    merge(&t).unwrap();
    assert_eq!(merge(&t), Err(Error::NoteSpent));
    collect(&t, 42 * UNIT).unwrap();
    assert_eq!(collect(&t, 42 * UNIT), Err(Error::NoteSpent));
}

#[test]
fn collect_amount_is_bound_by_the_proof() {
    let t = setup();
    merge(&t).unwrap();
    assert_eq!(collect(&t, 41 * UNIT), Err(Error::InvalidProof));
}

#[test]
fn treasury_admin() {
    let t = setup();
    assert_eq!(t.vault.keeper_share_bps(), 3000);
    assert_eq!(t.vault.try_init_treasury(&vk(&t.env, &fx()["merge_vk"]), &3000), Err(Ok(Error::TreasuryAlreadyInitialized)));
    assert_eq!(t.vault.try_set_treasury_config(&vk(&t.env, &fx()["merge_vk"]), &10_001), Err(Ok(Error::InvalidConfig)));
}
