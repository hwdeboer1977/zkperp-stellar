# 14. Keeper backend server

The keepers (steps 8, 11–13) are now a **backend service**: one long-running
server per keeper, supervised by **pm2**, with an HTTP API for health and
Prometheus metrics. pm2 also runs the relayer (step 6), the treasury's daily
fee collection (step 9) and the oracle signers (step 15), so the whole backend
starts with one command.

## 14.1 Architecture

```
pm2 ─┬─ keeper-1 ─ services/keeper-server.mjs ──HTTP :3041 /health /metrics
     │               └─ fork ─ services/worker.mjs keeper 1 ── lib/keeper-service.mjs (the loop)
     ├─ keeper-2 (:3042), keeper-3 (:3043)
     ├─ oracle-1..3 (step 15, :3020-3022)
     ├─ relay  (scripts/relay-server.mjs, :3030)
     └─ treasury (scripts/treasury.mjs --collect, cron 03:00 daily)
```

- **`lib/keeper-service.mjs`** holds the keeper loop (formerly
  `scripts/keeper.mjs`), unchanged in behaviour:
  - sync events and decrypt keeper / order / limit notes;
  - fill reached limit orders;
  - execute crossed stop-loss / take-profit orders;
  - liquidate positions below maintenance;
  - use the (n − 1) × 20 s stagger between keepers.

  It now also keeps state: ticks, last tick, mark price and its age, the 20
  most recent actions, error count and last error, and a `snapshot()` with
  counts and this keeper's fee credit.
- **The loop runs in a forked child process** (`services/worker.mjs`), and the
  server process only serves HTTP. Two lessons from testing this:
  - in a single process, the loop's synchronous stellar-CLI calls blocked the
    HTTP server for seconds, and the status view showed a running signer as
    DOWN;
  - in a *worker thread*, snarkjs's own `web-worker` dependency failed to load
    (it must run on a main thread).

  A child process fixes both. Requests are now answered in about 1 ms, and a
  test (`test/fork.test.mjs`) proves and verifies inside a forked child.
- If the loop exits, the server exits too, and **pm2 restarts it** (5 s delay,
  restart counter visible in `pm2 status`).
- **Privacy:** the API exposes **counts only**, never decrypted position data,
  and binds to `127.0.0.1`. The keeper's position database stays in
  `.zkperp/keeper-<n>-<vault>.json` (gitignored, mode 600).

## 14.2 API

`GET http://127.0.0.1:304<n>/health`:
```json
{
  "status": "ok",                 // ok | price-stale | stale | starting
  "keeper": 1, "account": "GABJ…TDQU", "vault": "CAFE…LIWE",
  "ticks": 12, "lastTick": "…", "errors": 0, "lastError": null,
  "mark": { "price": "814092785654", "round": "…497", "ageSeconds": 2651, "maxAgeSeconds": 3900 },
  "tracked": { "positions": 0, "orders": 0, "limits": 0 },
  "due": 0,
  "actions": [ { "at": "…", "what": "liquidated #1: loss 341.46 to the pool, …" } ],
  "owed": "0"
}
```
- `stale`: no tick for 6 × tick interval + 2 min.
- `price-stale`: the vault's price is older than `max_price_age`, so opens and
  actions are blocked until the oracle catches up.

`GET /metrics` (Prometheus): `zkperp_keeper_up`, `_ticks_total`,
`_errors_total`, `_positions_tracked`, `_orders_tracked`, `_limits_tracked`,
`_due`, `_mark_price_age_seconds`, `_actions_recent`, `_owed_units`.

## 14.3 Running it

```sh
cd circuits
pm2 start services/ecosystem.config.cjs        # all 8 processes (or --only keeper-1,keeper-2,keeper-3)
pm2 status                                     # restarts, memory, uptime
node services/status.mjs                       # one table: oracle-1..3 and keeper-1..3 health
pm2 logs keeper-1                              # logs also in .zkperp/logs/
pm2 stop all  |  pm2 delete all
pm2 save && pm2 startup                        # survive reboots (run the command it prints)
```
- Every process reads `.env`: `VAULT_ID`, `KEEPER_n_SECRET`, `KEEPER_VIEW_SK`,
  and so on.
- `KEEPER_TICK_MS` (10 s) and `KEEPER_STAGGER_MS` (20 s) tune the loop;
  `KEEPER_PORT` overrides the port.
- Running a keeper by hand still works: `node scripts/keeper.mjs --keeper 1`
  (no API) or `node services/keeper-server.mjs --keeper 1`.

## 14.4 Testnet (2026-10-16)

The full backend runs under pm2 against the **real vault**:
```
$ pm2 start services/ecosystem.config.cjs --only oracle-1,oracle-2,oracle-3,keeper-1,keeper-2,keeper-3,relay
$ node services/status.mjs
oracle-1  ok  chainlink round …6497 (2786 s old)  vault 81409.28, 2774 s old  submitted 0
oracle-2  ok  …
oracle-3  ok  …
keeper-1  ok  1 ticks, last 15:54:04  tracking 0 pos / 0 orders / 0 limits  actions 0, errors 0, owed 0.00
keeper-2  ok  …                                                             owed 2.00
keeper-3  ok  …                                                             owed 2.00
```
(Keepers 2 and 3 show the 2.00 fee credit from step 9; keeper 1 already
claimed its share.) `/health` answers in about 1 ms. No errors in
`.zkperp/logs/*.err.log` after switching the loop to a child process.

**A keeper server acting** (demo vault, a 4th keeper-1 instance on port 3051 so
the real-vault stack was untouched): see §14.5.

## 14.5 Keeper server liquidation (demo vault)

A 10× long (#22, 4,000 / 400 at 82,000) was opened on the demo vault, the test
price crashed to 75,000, and a keeper-1 server started on port 3051 with
`VAULT_ID` set to the demo vault. A watcher polled its `/health` until it
reported an action:
```
[keeper 1] #22 is below maintenance at 75,000 (equity 50.53)
[keeper 1] liquidated #22: loss 341.46 to the pool, 30.53 back to the owner (note leaf 24)

GET :3051/health -> status: ok | ticks: 2 | mark: 75000.0
                    action: 15:55:52 liquidated #22: loss 341.46 to the pool, 30.53 back to the owner (note leaf 24)
GET :3051/metrics -> zkperp_keeper_up 1, zkperp_keeper_actions_recent 1, zkperp_keeper_errors_total 0
```
The liquidation ran inside the forked loop (proof + submission), and the
server reported it while staying responsive. The demo server was then stopped
by its port, leaving the pm2 stack untouched.
