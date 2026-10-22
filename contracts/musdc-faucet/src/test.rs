#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env};

fn setup(env: &Env) -> (Address, MusdcFaucetClient<'_>) {
    let issuer = Address::generate(env);
    let sac = env.register_stellar_asset_contract_v2(issuer.clone()).address();
    let faucet_id = env.register(MusdcFaucet, (&sac,));
    // Hand the SAC admin role to the faucet; only this call needs the issuer.
    env.mock_all_auths();
    token::StellarAssetClient::new(env, &sac).set_admin(&faucet_id);
    env.set_auths(&[]);
    (sac, MusdcFaucetClient::new(env, &faucet_id))
}

#[test]
fn anyone_can_mint_without_auth() {
    let env = Env::default();
    let (sac, faucet) = setup(&env);
    let trader = Address::generate(&env);
    let contract_holder = env.register(MusdcFaucet, (&sac,)); // any contract address

    // No auths are mocked: the faucet authorizes the SAC call as its admin.
    faucet.mint(&trader, &1_000_0000000);
    faucet.mint(&contract_holder, &5_0000000);

    let t = token::Client::new(&env, &sac);
    assert_eq!(t.balance(&trader), 1_000_0000000);
    assert_eq!(t.balance(&contract_holder), 5_0000000);
    assert_eq!(t.decimals(), 7);
    assert_eq!(faucet.sac(), sac);
}

#[test]
fn rejects_non_positive_amounts() {
    let env = Env::default();
    let (_, faucet) = setup(&env);
    let to = Address::generate(&env);
    assert_eq!(faucet.try_mint(&to, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(faucet.try_mint(&to, &-1), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn minted_tokens_are_ordinary_sep41() {
    let env = Env::default();
    let (sac, faucet) = setup(&env);
    let (a, b) = (Address::generate(&env), Address::generate(&env));
    faucet.mint(&a, &10_0000000);
    env.mock_all_auths();
    token::Client::new(&env, &sac).transfer(&a, &b, &4_0000000);
    let t = token::Client::new(&env, &sac);
    assert_eq!((t.balance(&a), t.balance(&b)), (6_0000000, 4_0000000));
}
