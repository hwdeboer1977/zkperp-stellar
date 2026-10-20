# 15. Price-oracle backend server

The three oracle signers (step 5) are now **backend servers**, run by pm2 with
the keepers (step 14). Each server serves its signatures to its peers, as
before, and adds health, price and metrics endpoints.

(The request listed two "Step 14" items; the oracle server is numbered 15.)

## 15.1 Architecture

```
pm2 ─ oracle-<n> ─ services/oracle-server.mjs ──HTTP :302<n>  /signature/<round> /health /price /metrics
                     └─ fork ─ services/worker.mjs oracle n ── lib/oracle-service.mjs (the loop)
```

- **`lib/oracle-service.mjs`** holds the signer loop from step 5, unchanged in
  behaviour:
  - poll Chainlink BTC/USD every 15 s;
  - sign each new round;
  - after (n − 1) × 20 s, fetch a peer's signature and submit `set_price`
    with 2 of 3 signatures.

  It now also records polls, errors, the vault's current price and its age,
  and reports each new signature to the server (`onSigned`).
- **The loop runs in a forked child process**, and the server serves HTTP.
  That matters more here than for keepers: peers fetch `/signature/<round>`
  with a 3-second timeout, and a blocked signer delays the whole quorum. With
  the split, the server answers in about 1 ms even while the loop waits on a
  submission.
- **Same ports as step 5** (`3019 + n`), so peer discovery (`ORACLE_PEERS`)
  doesn't change. Binds to `127.0.0.1`; set `ORACLE_HOST=0.0.0.0` and
  `ORACLE_PEERS` when signers run on separate machines, which is the
  production setup with independent operators.
- `scripts/relayer.mjs` now just starts this server, so the commands in
  docs 5–13 still work.

## 15.2 API

| Endpoint | Returns |
|---|---|
| `GET /signature/<round>` | `{ report: { round, price, updatedAt }, sig, seenAt }`, this signer's signature on that round (for peers) |
| `GET /health` | `status` (`ok` / `vault-price-stale` / `chainlink-stale` / `error` / `starting`), `lastRound`, `chainlinkRoundAgeSeconds`, `vaultPrice { price, round, ageSeconds, maxAgeSeconds }`, `vaultRound`, `polls`, `submissions`, `lastSubmission`, `errors`, `lastError` |
| `GET /price` | `{ chainlink: { round, price, updatedAt }, vault: { round, price, ageSeconds } }` |
| `GET /metrics` | `zkperp_oracle_up`, `_polls_total`, `_submissions_total`, `_errors_total`, `_chainlink_round_age_seconds`, `_vault_price_age_seconds`, `_vault_price` |

Status rules:
- `chainlink-stale`: no new round for 2 h (the BTC/USD heartbeat is 1 h);
- `vault-price-stale`: the vault's price is older than `max_price_age`, so
  opens, closes and keeper actions are blocked;
- `error`: an error in the last minute.

## 15.3 Running it

```sh
cd circuits
pm2 start services/ecosystem.config.cjs --only oracle-1,oracle-2,oracle-3
curl -s http://127.0.0.1:3020/price
node services/status.mjs
```
Uses `ORACLE_n_SECRET`, `VAULT_ID` and `EVM_RPC_URL` from `.env`;
`RELAYER_POLL_MS`, `RELAYER_STAGGER_MS` and `RELAYER_TICK_MS` tune the loop.

## 15.4 Testnet (2026-10-16)

The three servers run under pm2 against the real vault:
```
$ curl -s http://127.0.0.1:3020/price
{ "chainlink": { "round": "129127208515966886497", "price": "81409.28", "updatedAt": 1792163267 },
  "vault":     { "round": "129127208515966886497", "price": "81409.28", "ageSeconds": 2672 } }
oracle-1  ok  chainlink round …6497 (2786 s old)  vault 81409.28, 2774 s old  submitted 0
```
"Submitted 0" because round `…497` was already on chain (step 10); the servers
submit when Chainlink publishes the next round. The submission and failover
logic is the step-5 code, verified live there (signer 1 submitting with 2;
signer 2 taking over with signer 1 down).

## 15.5 Operations

- **Keep the price fresh.** If all three signers are down for over
  `max_price_age` (65 min), the vault refuses opens, closes and keeper
  actions. `status.mjs` shows `vault-price-stale`, and the keepers report
  `price-stale`.
- **Separate operators in production.** Each signer should run on its own
  machine with its own key and Ethereum RPC; only `ORACLE_PEERS` and
  `ORACLE_HOST` change.
- **Alerting.** Scrape `/metrics` from all six servers: alert on
  `zkperp_oracle_vault_price_age_seconds > 3000`, `zkperp_oracle_up == 0`, and
  `zkperp_keeper_up == 0`.
