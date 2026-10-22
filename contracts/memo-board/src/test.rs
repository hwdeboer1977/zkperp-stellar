#![cfg(test)]
use super::*;
use soroban_sdk::Env;

fn setup() -> (Env, MemoBoardClient<'static>) {
    let env = Env::default();
    let id = env.register(MemoBoard, ());
    let client = MemoBoardClient::new(&env, &id);
    (env, client)
}

#[test]
fn post_and_page() {
    let (env, c) = setup();
    assert_eq!(c.count(), 0);
    for i in 0..60u8 {
        assert_eq!(c.post(&Bytes::from_array(&env, &[i; 512])), i as u32);
    }
    assert_eq!(c.count(), 60);
    let page = c.get(&0, &100); // capped at MAX_PAGE
    assert_eq!(page.len(), MAX_PAGE);
    assert_eq!(page.get(7).unwrap(), Bytes::from_array(&env, &[7u8; 512]));
    let tail = c.get(&55, &50);
    assert_eq!(tail.len(), 5);
    assert_eq!(tail.get(4).unwrap(), Bytes::from_array(&env, &[59u8; 512]));
    assert_eq!(c.get(&60, &10).len(), 0);
    assert_eq!(c.get(&u32::MAX, &10).len(), 0);
}

#[test]
fn rejects_empty_and_oversized() {
    let (env, c) = setup();
    assert_eq!(c.try_post(&Bytes::new(&env)), Err(Ok(Error::Empty)));
    assert_eq!(c.try_post(&Bytes::from_array(&env, &[0u8; 1025])), Err(Ok(Error::TooLarge)));
    assert_eq!(c.post(&Bytes::from_array(&env, &[0u8; 1024])), 0);
}

#[test]
fn needs_no_signature() {
    let (env, c) = setup();
    c.post(&Bytes::from_array(&env, &[1u8; 16]));
    assert!(env.auths().is_empty());
}
