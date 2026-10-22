#![cfg(test)]
//! 2-of-3 signed prices and signer rotation.

extern crate std;

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, Event as _, Vec,
};

/// Test signer `i` (1-based): ed25519 seed [i; 32], same keys as
/// `circuits/scripts/oracle-fixture.mjs`.
pub(crate) fn key(i: u8) -> SigningKey {
    SigningKey::from_bytes(&[i; 32])
}

pub(crate) fn signer_keys(env: &Env) -> Vec<BytesN<32>> {
    let mut v = Vec::new(env);
    for i in 1..=3 {
        v.push_back(BytesN::from_array(env, &key(i).verifying_key().to_bytes()));
    }
    v
}

pub(crate) fn sig(env: &Env, i: u8, digest: &BytesN<32>) -> BytesN<64> {
    BytesN::from_array(env, &key(i).sign(&digest.to_array()).to_bytes())
}

/// Sets a price signed by signers 1 and 2.
pub(crate) fn set_signed_price(vault: &ZkPerpVaultClient, round: u128, price: i128, updated_at: u64) {
    let d = vault.price_digest(&round, &price, &updated_at);
    vault.set_price(&round, &price, &updated_at, &0, &1, &sig(&vault.env, 1, &d), &sig(&vault.env, 2, &d));
}

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/oracle.json")).unwrap()
}

fn hex<const N: usize>(env: &Env, s: &str) -> BytesN<N> {
    let mut b = [0u8; N];
    for i in 0..N {
        b[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(env, &b)
}

/// A vault (at `at`, if given) with trading on, test signers, clock at `now`.
fn vault<'a>(env: &'a Env, at: Option<&str>, now: u64) -> ZkPerpVaultClient<'a> {
    env.mock_all_auths();
    let args = (Address::generate(env), Address::generate(env), 1i128);
    let id = match at {
        Some(s) => {
            let a = Address::from_str(env, s);
            env.register_at(&a, ZkPerpVault, args)
        }
        None => env.register(ZkPerpVault, args),
    };
    let v = ZkPerpVaultClient::new(env, &id);
    let config = PerpConfig {
        signers: signer_keys(env),
        keeper_key: KeeperKey { x: soroban_sdk::U256::from_u32(env, 1), y: soroban_sdk::U256::from_u32(env, 2) },
        fee_bps: 10,
        max_price_age: 3900,
    };
    let f: serde_json::Value = serde_json::from_str(include_str!("fixtures/open.json")).unwrap();
    let vk = &f["vk"];
    let mut ic = Vec::new(env);
    for p in vk["ic"].as_array().unwrap() {
        ic.push_back(hex(env, p.as_str().unwrap()));
    }
    let open_vk = groth16::VerificationKey {
        alpha: hex(env, vk["alpha"].as_str().unwrap()),
        beta: hex(env, vk["beta"].as_str().unwrap()),
        gamma: hex(env, vk["gamma"].as_str().unwrap()),
        delta: hex(env, vk["delta"].as_str().unwrap()),
        ic,
    };
    v.init_perp(&config, &open_vk);
    env.ledger().set_timestamp(now);
    v
}

#[test]
fn js_and_contract_sign_the_same_bytes() {
    let env = Env::default();
    let f = fx();
    let t: u64 = f["updated_at"].as_str().unwrap().parse().unwrap();
    let v = vault(&env, Some(f["vault"].as_str().unwrap()), t + 30);
    let round: u128 = f["round"].as_str().unwrap().parse().unwrap();
    let price: i128 = f["price"].as_str().unwrap().parse().unwrap();

    assert_eq!(v.price_digest(&round, &price, &t), hex(&env, f["digest"].as_str().unwrap()));
    // Signatures made by stellar-sdk (signers 1 and 3) verify on-chain.
    v.set_price(&round, &price, &t, &0, &2, &hex(&env, f["sig_1"].as_str().unwrap()), &hex(&env, f["sig_3"].as_str().unwrap()));
    let ev = PriceSet { round, price, time: t, signers: soroban_sdk::vec![&env, 0, 2] };
    assert_eq!(
        env.events().all().filter_by_contract(&v.address).events().last().unwrap(),
        &ev.to_xdr(&env, &v.address)
    );
    assert_eq!(v.mark_price(), MarkPrice { price, time: t, round, signers: soroban_sdk::vec![&env, 0, 2] });

    let r = &f["rotation"];
    let new_key: BytesN<32> = hex(&env, r["key"].as_str().unwrap());
    assert_eq!(v.rotation_digest(&0, &2, &new_key), hex(&env, r["digest"].as_str().unwrap()));
}

#[test]
fn rounds_only_move_forward_and_time_is_checked() {
    let env = Env::default();
    let v = vault(&env, None, 10_000);
    set_signed_price(&v, 100, 50, 9_000);

    let try_set = |round: u128, t: u64| {
        let d = v.price_digest(&round, &60, &t);
        v.try_set_price(&round, &60, &t, &0, &1, &sig(&env, 1, &d), &sig(&env, 2, &d))
    };
    assert_eq!(try_set(100, 9_500), Err(Ok(Error::StaleRound)), "same round replayed");
    assert_eq!(try_set(99, 9_500), Err(Ok(Error::StaleRound)), "older round");
    assert_eq!(try_set(101, 8_999), Err(Ok(Error::PriceTimeInvalid)), "older than current");
    assert_eq!(try_set(101, 10_001), Err(Ok(Error::PriceTimeInvalid)), "in the future");
    assert_eq!(try_set(101, 9_000), Ok(Ok(())), "same time, newer round");
    assert_eq!(v.mark_price().price, 60);
}

#[test]
fn needs_two_different_signers_in_order() {
    let env = Env::default();
    let v = vault(&env, None, 10_000);
    let d = v.price_digest(&1, &50, &9_000);
    let (s1, s2) = (sig(&env, 1, &d), sig(&env, 2, &d));
    for (a, b) in [(0u32, 0u32), (1, 0), (2, 3)] {
        assert_eq!(v.try_set_price(&1, &50, &9_000, &a, &b, &s1, &s2), Err(Ok(Error::InvalidSignerSlots)));
    }
}

#[test]
#[should_panic]
fn signature_by_the_wrong_signer_traps() {
    let env = Env::default();
    let v = vault(&env, None, 10_000);
    let d = v.price_digest(&1, &50, &9_000);
    // Claims slots 0 and 1, but the second signature is by signer 3.
    v.set_price(&1, &50, &9_000, &0, &1, &sig(&env, 1, &d), &sig(&env, 3, &d));
}

#[test]
#[should_panic]
fn signature_over_another_price_traps() {
    let env = Env::default();
    let v = vault(&env, None, 10_000);
    let d = v.price_digest(&1, &50, &9_000);
    v.set_price(&1, &51, &9_000, &0, &1, &sig(&env, 1, &d), &sig(&env, 2, &d));
}

#[test]
#[should_panic]
fn report_for_another_vault_traps() {
    let env = Env::default();
    let (a, b) = (vault(&env, None, 10_000), vault(&env, None, 10_000));
    let d = a.price_digest(&1, &50, &9_000);
    b.set_price(&1, &50, &9_000, &0, &1, &sig(&env, 1, &d), &sig(&env, 2, &d));
}

#[test]
fn two_signers_rotate_the_third() {
    let env = Env::default();
    let v = vault(&env, None, 10_000);
    let new_key = BytesN::from_array(&env, &key(4).verifying_key().to_bytes());
    let d = v.rotation_digest(&0, &2, &new_key);
    v.rotate_signer(&2, &new_key, &0, &1, &sig(&env, 1, &d), &sig(&env, 2, &d));
    assert_eq!(v.perp_config().signers.get(2).unwrap(), new_key);
    assert_eq!(v.signer_epoch(), 1);

    // The same rotation can't be replayed (epoch moved on): it now traps,
    // because the digest differs. Signer 4 now signs prices; signer 3 doesn't.
    let p = v.price_digest(&1, &50, &9_000);
    v.set_price(&1, &50, &9_000, &0, &2, &sig(&env, 1, &p), &sig(&env, 4, &p));
    assert_eq!(v.mark_price().signers, soroban_sdk::vec![&env, 0, 2]);
}

#[test]
fn rotation_to_a_duplicate_key_is_refused() {
    let env = Env::default();
    let v = vault(&env, None, 10_000);
    let dup = v.perp_config().signers.get(0).unwrap();
    let d = v.rotation_digest(&0, &2, &dup);
    assert_eq!(
        v.try_rotate_signer(&2, &dup, &0, &1, &sig(&env, 1, &d), &sig(&env, 2, &d)),
        Err(Ok(Error::InvalidConfig))
    );
}
