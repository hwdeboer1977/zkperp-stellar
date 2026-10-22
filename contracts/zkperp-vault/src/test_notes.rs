#![cfg(test)]
//! Shielded collateral with real proofs from snarkjs (`fixtures/notes.json`,
//! written by `circuits/scripts/notes-fixture.mjs`): deposit a note (leaf 0),
//! open privately from it (position leaf 1, change leaf 2), withdraw 100 from
//! the change note.

extern crate std;

use super::*;
use crate::test_oracle::{set_signed_price, signer_keys};
use groth16::{Proof, VerificationKey};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, Address, BytesN, Env, Event as _, Vec, U256,
};

const UNIT: i128 = 10_000_000;
const MAX_PAYOUT: i128 = 5_000 * UNIT;

fn fx() -> serde_json::Value {
    serde_json::from_str(include_str!("fixtures/notes.json")).unwrap()
}

pub(crate) fn s(v: &serde_json::Value) -> &str {
    v.as_str().unwrap()
}

pub(crate) fn dec(env: &Env, v: &serde_json::Value) -> U256 {
    // Decimal string -> U256 via u128 halves.
    let n: num_like::Big = s(v).parse().unwrap();
    n.to_u256(env)
}

/// Tiny decimal parser for 256-bit values (avoids a bigint dependency).
mod num_like {
    extern crate std;
    use soroban_sdk::{Env, U256};
    pub struct Big(pub [u8; 32]);
    impl std::str::FromStr for Big {
        type Err = ();
        fn from_str(s: &str) -> Result<Self, ()> {
            let mut b = [0u8; 32];
            for ch in s.bytes() {
                let mut carry = (ch - b'0') as u32;
                for byte in b.iter_mut().rev() {
                    let v = (*byte as u32) * 10 + carry;
                    *byte = (v & 0xff) as u8;
                    carry = v >> 8;
                }
            }
            Ok(Big(b))
        }
    }
    impl Big {
        pub fn to_u256(&self, env: &Env) -> U256 {
            U256::from_be_bytes(env, &soroban_sdk::Bytes::from_array(env, &self.0))
        }
    }
}

pub(crate) fn bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
    let mut b = [0u8; N];
    for i in 0..N {
        b[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(env, &b)
}

pub(crate) fn vk(env: &Env, v: &serde_json::Value) -> VerificationKey {
    let mut ic = Vec::new(env);
    for p in v["ic"].as_array().unwrap() {
        ic.push_back(bytes(env, s(p)));
    }
    VerificationKey { alpha: bytes(env, s(&v["alpha"])), beta: bytes(env, s(&v["beta"])), gamma: bytes(env, s(&v["gamma"])), delta: bytes(env, s(&v["delta"])), ic }
}

pub(crate) fn proof(env: &Env, v: &serde_json::Value) -> Proof {
    Proof { a: bytes(env, s(&v["a"])), b: bytes(env, s(&v["b"])), c: bytes(env, s(&v["c"])) }
}

struct T<'a> {
    env: Env,
    vault: ZkPerpVaultClient<'a>,
    token: token::Client<'a>,
    trader: Address,
}

/// Vault with 20,000 liquidity, trading + notes on, price set, and the
/// trader's 1,000 note deposited at leaf 0.
fn setup<'a>() -> T<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();
    let f = fx();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env)).address();
    let id = env.register(ZkPerpVault, (Address::generate(&env), &sac, MAX_PAYOUT));
    let vault = ZkPerpVaultClient::new(&env, &id);
    let mint = token::StellarAssetClient::new(&env, &sac);
    let (lp, trader) = (Address::generate(&env), Address::generate(&env));
    mint.mint(&lp, &(20_000 * UNIT));
    mint.mint(&trader, &(1_000 * UNIT));
    vault.deposit(&lp, &(20_000 * UNIT));

    let open_vk: serde_json::Value = serde_json::from_str(include_str!("fixtures/open.json")).unwrap();
    let config = PerpConfig {
        signers: signer_keys(&env),
        keeper_key: KeeperKey { x: dec(&env, &f["keeper_pk"][0]), y: dec(&env, &f["keeper_pk"][1]) },
        fee_bps: 10,
        max_price_age: 3600,
    };
    vault.init_perp(&config, &vk(&env, &open_vk["vk"]));
    vault.init_notes(&vk(&env, &f["open_private_vk"]), &vk(&env, &f["withdraw_vk"]));
    let t: u64 = s(&f["open"]["open_time"]).parse().unwrap();
    env.ledger().set_timestamp(t + 10);
    set_signed_price(&vault, 1, s(&f["open"]["price"]).parse().unwrap(), t + 10);

    let d = &f["deposit"];
    let leaf = vault.deposit_note(&trader, &s(&d["amount"]).parse::<i128>().unwrap(), &dec(&env, &d["inner"]));
    assert_eq!(leaf, 0);
    T { token: token::Client::new(&env, &sac), vault, trader, env }
}

fn open_private(t: &T, tamper: impl Fn(&mut Vec<U256>)) -> Result<u32, Error> {
    let o = &fx()["open"];
    let env = &t.env;
    let mut note = Vec::new(env);
    for e in o["note"].as_array().unwrap() {
        note.push_back(dec(env, e));
    }
    tamper(&mut note);
    let r = t.vault.try_open_position_private(
        &dec(env, &o["root"]),
        &dec(env, &o["nullifier"]),
        &dec(env, &o["commitment"]),
        &dec(env, &o["change"]),
        &KeeperKey { x: dec(env, &o["note_r"][0]), y: dec(env, &o["note_r"][1]) },
        &note,
        &s(&o["open_time"]).parse().unwrap(),
        &proof(env, &o["proof"]),
    );
    match r {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn withdraw(t: &T, recipient: &Address, amount: i128) -> Result<u32, Error> {
    let w = &fx()["withdraw"];
    let env = &t.env;
    match t.vault.try_withdraw_note(&dec(env, &w["root"]), &dec(env, &w["nullifier"]), &amount, recipient, &dec(env, &w["change"]), &proof(env, &w["proof"])) {
        Ok(Ok(i)) => Ok(i),
        Err(Ok(e)) => Err(e),
        other => panic!("unexpected {other:?}"),
    }
}

fn recipient(t: &T) -> Address {
    Address::from_str(&t.env, s(&fx()["withdraw"]["recipient"]))
}

#[test]
fn deposit_computes_the_note_commitment_on_chain() {
    let t = setup();
    let d = &fx()["deposit"];
    assert_eq!(t.vault.merkle_root(), dec(&t.env, &d["root"]), "vault's Poseidon(amount, inner) = JS commitment");
    assert_eq!(t.vault.leaves(&0, &10), soroban_sdk::vec![&t.env, dec(&t.env, &d["commitment"])]);
    assert_eq!(t.vault.trader_funds(), 1_000 * UNIT);
    assert_eq!(t.token.balance(&t.trader), 0);
}

#[test]
fn private_open_then_withdraw() {
    let t = setup();
    let f = fx();
    let tokens_before = t.token.balance(&t.vault.address);

    // The proof is the only authority: no account signs the open.
    t.env.set_auths(&[]);
    assert_eq!(open_private(&t, |_| {}), Ok(1));
    let o = &f["open"];
    let ev = PrivateOpened {
        leaf_index: 1,
        commitment: dec(&t.env, &o["commitment"]),
        change_leaf: 2,
        change_commitment: dec(&t.env, &o["change"]),
        nullifier: dec(&t.env, &o["nullifier"]),
        root: dec(&t.env, &o["root_after"]),
        note_r: KeeperKey { x: dec(&t.env, &o["note_r"][0]), y: dec(&t.env, &o["note_r"][1]) },
        note: {
            let mut v = Vec::new(&t.env);
            for e in o["note"].as_array().unwrap() {
                v.push_back(dec(&t.env, e));
            }
            v
        },
    };
    assert_eq!(t.env.events().all().filter_by_contract(&t.vault.address).events().last().unwrap(), &ev.to_xdr(&t.env, &t.vault.address));

    assert_eq!(t.token.balance(&t.vault.address), tokens_before, "no token moved");
    assert_eq!(t.vault.trader_funds(), 1_000 * UNIT, "value moved from note to position, total unchanged");
    assert_eq!(t.vault.live_positions(), 1);
    assert!(t.vault.is_spent(&dec(&t.env, &o["nullifier"])));
    assert_eq!(t.vault.merkle_root(), dec(&t.env, &o["root_after"]), "same tree as JS");
    assert_eq!(t.vault.leaves(&0, &10).len(), 3);

    // Withdraw 100 from the change note to the bound recipient; anyone may submit.
    let to = recipient(&t);
    assert_eq!(withdraw(&t, &to, 100 * UNIT), Ok(3));
    assert_eq!(t.token.balance(&to), 100 * UNIT);
    assert_eq!(t.vault.trader_funds(), 900 * UNIT);
    assert_eq!(t.token.balance(&t.vault.address), tokens_before - 100 * UNIT);
}

#[test]
fn a_note_can_be_spent_once() {
    let t = setup();
    assert_eq!(open_private(&t, |_| {}), Ok(1));
    assert_eq!(open_private(&t, |_| {}), Err(Error::NoteSpent));
    let to = recipient(&t);
    // The withdraw proof is against the tree after the open.
    assert_eq!(withdraw(&t, &to, 100 * UNIT), Ok(3));
    assert_eq!(withdraw(&t, &to, 100 * UNIT), Err(Error::NoteSpent));
}

#[test]
fn relayer_cannot_redirect_or_change_a_withdrawal() {
    let t = setup();
    open_private(&t, |_| {}).unwrap();
    let other = Address::generate(&t.env);
    assert_eq!(withdraw(&t, &other, 100 * UNIT), Err(Error::InvalidProof), "different recipient");
    assert_eq!(withdraw(&t, &recipient(&t), 101 * UNIT), Err(Error::InvalidProof), "different amount");
}

#[test]
fn tampered_keeper_note_is_rejected() {
    let t = setup();
    assert_eq!(open_private(&t, |n| n.set(1, U256::from_u32(&t.env, 7))), Err(Error::InvalidProof));
}

#[test]
fn unknown_root_is_rejected() {
    let t = setup();
    let w = &fx()["withdraw"];
    // The withdraw proof's root only exists after the open.
    let r = t.vault.try_withdraw_note(&dec(&t.env, &w["root"]), &dec(&t.env, &w["nullifier"]), &(100 * UNIT), &recipient(&t), &dec(&t.env, &w["change"]), &proof(&t.env, &w["proof"]));
    assert_eq!(r, Err(Ok(Error::UnknownRoot)));
}

#[test]
fn recipient_field_matches_js() {
    let t = setup();
    let w = &fx()["withdraw"];
    assert_eq!(t.vault.recipient_digest(&recipient(&t)), dec(&t.env, &w["recipient_field"]));
}

#[test]
fn notes_admin_functions() {
    let t = setup();
    let f = fx();
    assert_eq!(
        t.vault.try_init_notes(&vk(&t.env, &f["open_private_vk"]), &vk(&t.env, &f["withdraw_vk"])),
        Err(Ok(Error::NotesAlreadyInitialized))
    );
    // Backfill only fills missing leaves of the tree.
    t.env.as_contract(&t.vault.address, || t.env.storage().persistent().remove(&DataKey::Leaf(0)));
    assert_eq!(t.vault.leaves(&0, &1).get(0).unwrap(), U256::from_u32(&t.env, 0));
    let c = dec(&t.env, &f["deposit"]["commitment"]);
    t.vault.backfill_leaves(&0, &soroban_sdk::vec![&t.env, c.clone(), U256::from_u32(&t.env, 9)]);
    assert_eq!(t.vault.leaves(&0, &5), soroban_sdk::vec![&t.env, c], "index 1 is not in the tree yet");
    t.env.set_auths(&[]);
    assert!(t.vault.try_backfill_leaves(&0, &Vec::new(&t.env)).is_err(), "admin only");
}

/// Costs as compiled WASM. Build first; skipped if the .wasm is missing.
#[test]
fn wasm_note_costs() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/wasm32v1-none/release/zkperp_vault.wasm");
    let Ok(wasm) = std::fs::read(path) else {
        std::println!("skipping wasm_note_costs: {path} not found");
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
    let open_vk: serde_json::Value = serde_json::from_str(include_str!("fixtures/open.json")).unwrap();
    vault.init_perp(
        &PerpConfig { signers: signer_keys(&env), keeper_key: KeeperKey { x: dec(&env, &f["keeper_pk"][0]), y: dec(&env, &f["keeper_pk"][1]) }, fee_bps: 10, max_price_age: 3600 },
        &vk(&env, &open_vk["vk"]),
    );
    vault.init_notes(&vk(&env, &f["open_private_vk"]), &vk(&env, &f["withdraw_vk"]));
    let o = &f["open"];
    let t: u64 = s(&o["open_time"]).parse().unwrap();
    env.ledger().set_timestamp(t + 10);
    set_signed_price(&vault, 1, s(&o["price"]).parse().unwrap(), t + 10);

    let measure = |name: &str, run: &mut dyn FnMut()| {
        env.cost_estimate().budget().reset_unlimited();
        run();
        let cpu = env.cost_estimate().budget().cpu_instruction_cost();
        std::println!("wasm {name}: cpu_insns={cpu} ({:.1}% of 400M tx limit)", cpu as f64 / 4e6);
    };
    measure("deposit_note", &mut || {
        vault.deposit_note(&trader, &(1_000 * UNIT), &dec(&env, &f["deposit"]["inner"]));
    });
    let mut note = Vec::new(&env);
    for e in o["note"].as_array().unwrap() {
        note.push_back(dec(&env, e));
    }
    measure("open_position_private", &mut || {
        vault.open_position_private(&dec(&env, &o["root"]), &dec(&env, &o["nullifier"]), &dec(&env, &o["commitment"]), &dec(&env, &o["change"]),
            &KeeperKey { x: dec(&env, &o["note_r"][0]), y: dec(&env, &o["note_r"][1]) }, &note, &t, &proof(&env, &o["proof"]));
    });
    let w = &f["withdraw"];
    let to = Address::from_str(&env, s(&w["recipient"]));
    measure("withdraw_note", &mut || {
        vault.withdraw_note(&dec(&env, &w["root"]), &dec(&env, &w["nullifier"]), &(100 * UNIT), &to, &dec(&env, &w["change"]), &proof(&env, &w["proof"]));
    });
}
