# 7. Close a position

The owner closes a long or short at the vault's mark price (step 5). The
position settles against the LP pool: a profit comes out of the pool, a loss
goes into it. The trader's payout and the fees become **private notes**
(step 6), so the only public amounts are the pool's change. Closing frees the
position's `max_payout` reservation (step 3).

This is the Soroban counterpart of `closePosition` + `settle` in
zkperp-midnight, with the same rules and rounding.

## 7.1 Settlement rules

For a position with `size`, `collateral` (net of the opening fee),
`entryPrice`, `openFee`, closed at `exit` = the mark price:

| Quantity | Rule | Rounding |
|---|---|---|
| move, delta | `|exit − entry|`, `size × move` | — |
| who wins | long: `exit ≥ entry`; short: `exit ≤ entry` (flat: both "win" 0) | — |
| profit | `min(floor(delta / entry), max_payout)` | pool's favour; capped = enforced take-profit |
| loss | `ceil(delta / entry)`, at most the collateral | pool's favour |
| closing fee | `ceil(size × fee_bps / 10000)` (same rate as opening) | pool's favour |
| fee taken | `min(closing fee, collateral − loss)`; the rest (shortfall) is taken from the profit | — |
| **payout** (trader's note) | `collateral − loss − fee taken + profit − shortfall` | — |
| **fees** (treasury's note) | `openFee + fee taken` | — |
| **pool_in / pool_out** (public) | loss / profit − shortfall | — |

Value is conserved: `collateral + openFee = payout + fees + pool_in − pool_out`.
The JS tests check this for every scenario.

**Why fees go to a treasury note, not the pool:** the fees are a fixed
fraction of size. If they went into the pool, the pool's change would reveal
the size, even at an unchanged price. As on Midnight, they go privately to a
treasury, so the pool's change is the PnL alone and a flat close shows nothing.
The fee note's salt is `Poseidon(salt, 1)`, and keepers can compute that from
the keeper note. So the treasury, run with the keeper view key, can find and
spend fee notes without any extra encryption.

**Who can close:** whoever knows the position's `ownerSecret` (the owner
hash is in the commitment). Step-4 positions stored a random owner secret in
their record; step-6 positions derive it from `<ROLE>_SECRET`. The payout note
goes to an owner the closer chooses (the scripts use the closer's derived
owner), so both kinds pay into the same wallet of notes.

## 7.2 Circuit `circuits/close_position.circom`

~17,000 constraints. Trusted setup 2^15, single-party:
`scripts/setup.sh close_position 15`.

| | Signals |
|---|---|
| Public inputs | `root`, `exitPrice` (mark), `closeTime`, `feeBps`, `maxPayout`, `treasuryOwner` |
| Private inputs | the 8 position fields + `ownerSecret`, Merkle path, `pnl`, `closeFee`, `payoutOwner`, `payoutSalt` |
| Outputs | `nullifier` = Poseidon(salt, leaf), `payoutCommitment`, `feeCommitment`, `poolIn`, `poolOut` |

It proves:
- the position is in the tree and owned by the prover;
- the close is not dated before the open;
- the closing fee is exact;
- the PnL is exact (a profit is capped at `maxPayout`; when capped it isn't
  checked against the exact value);
- the settlement amounts above are right.

Amounts are chosen without branches, like Midnight's `settle`: every
`min`/select is a constraint, not an `if`.

Not included yet: Midnight's **borrow fee** (size × rate × time held). It
needs a new configuration field, and the deployed `PerpConfig` format would
have to change.

## 7.3 Contract (`contracts/zkperp-vault/src/close.rs`)

| Function | Auth | Description |
|---|---|---|
| `init_close(close_vk, treasury_owner)` | admin, once | Turns on closing; `treasury_owner` = Poseidon(treasury secret) |
| `set_close_config(close_vk, treasury_owner)` | admin | Replace either |
| `close_position(root, nullifier, payout, fee, pool_in, pool_out, close_time, proof) → leaf` | **none** | See below. Returns the payout note's leaf; the fee note is the next leaf. |
| `treasury_owner()` | — | View |

Checks in `close_position`:

| Check | Error |
|---|---|
| Closing is initialized | `CloseNotInitialized` (26) |
| `close_time ≤ now` and `now − close_time ≤ 300 s` | `BadCloseTime` (28) |
| Mark price fresh (`max_price_age`) | `StalePrice` (12) |
| Root is recent | `UnknownRoot` (23) |
| `0 ≤ pool_in < 2^63`, `0 ≤ pool_out ≤ max_payout` | `InvalidAmount` (1) |
| Every public input `< r` | `NotInField` (16) |
| Proof verifies against the mark price, fee rate, `max_payout` and treasury owner **from storage** | `InvalidProof` (17) |
| Position not closed before (nullifier, shared with notes) | `NoteSpent` (22) |

Then:
- `live_positions − 1`, which frees the reservation;
- `pool_value += pool_in − pool_out`;
- `trader_funds += pool_out − pool_in`;
- insert the payout and fee notes;
- emit `PositionClosed { nullifier, exit_price, pool_in, pool_out, payout_leaf, payout_commitment, fee_leaf, fee_commitment, root }`.

No token moves, so the token balance stays `pool_value + trader_funds`.

## 7.4 Cost (compiled WASM)

| | Instructions | Share of 400M |
|---|---|---|
| `close_position` (verify 11 inputs + 2 inserts) | **76.8M** | 19.2% |

## 7.5 Tests

**Circuit** (`cd circuits && npm test`, 3 new; 9 in total). Each scenario
proves, verifies and checks conservation:

| Scenario | Result |
|---|---|
| Long 5,000 at 10×, +10% | profit 500 from the pool |
| Short 5,000, price +4% | loss 200 to the pool |
| Flat close | pool sees 0 / 0; payout = collateral − closing fee |
| Long 20,000, +100% | profit capped at `max_payout` (5,000) |
| Long at 10×, −20% | loss takes all collateral; payout 0; no fee left to take |
| Wrong owner secret, close before open | can't be proven |

**Contract** (`cargo test -p zkperp-vault`, 7 new; 44 in total), with real
proofs (`src/fixtures/close.json`, from `circuits/scripts/close-fixture.mjs`):
deposit 1,000 → private long 4,000 / 400 at 81,921 → price +5% → close.

| Test | Shows |
|---|---|
| `closes_in_profit_and_settles_against_the_pool` | No auths needed; `pool_out` 200; `live_positions` 0, `reserved` 0; `pool_value` −200; `trader_funds` +200; no token moved; balance = pool + trader funds; event |
| `a_position_closes_once` | Second close → `NoteSpent` |
| `misstated_pool_amounts_are_rejected` | ±1 on `pool_in`/`pool_out` → `InvalidProof`; above `max_payout` → `InvalidAmount` |
| `price_moved_since_proving_is_rejected` | New price → `InvalidProof` |
| `close_time_and_price_freshness` | Too old / future close time → `BadCloseTime` |
| `close_admin` | `init_close` once, admin only; `treasury_owner` view |
| `wasm_close_cost` | §7.4 |

## 7.6 Scripts (`circuits/`)

| Command | Does |
|---|---|
| `node scripts/close.mjs <position leaf> [ROLE]` | Proves and relays a close; saves the payout note (owner `<ROLE>`) and the fee note (owner `treasury`); marks the position record closed |
| `node scripts/positions.mjs` | This machine's position records: open ones with PnL and payout at the current mark price, closed ones with their result |
| `node scripts/keeper-read.mjs` | Now also shows whether each position is **CLOSED** (keepers know the salt, so they can check its nullifier) |
| `node scripts/relay-server.mjs` | Now also relays `close_position` |

New in `.env`: `TREASURY_OWNER_SECRET` (a field secret, not a Stellar key) and
`TREASURY_OWNER_HASH`.

## 7.7 Testnet (2026-10-16)

**Upgrade of the real vault** `CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE`:
WASM hash `ebf0eab157240e9bb0a9ab8d08f164c1f49741639889c6eadc3f603f69df98bb`
(50.4 KB, 42 functions), then `init_close` with the close verification key and
`TREASURY_OWNER_HASH` (checked on-chain).

```sh
set -a; . ./.env; set +a
export STELLAR_ACCOUNT="$ADMIN_SECRET"
HASH=$(stellar contract upload --wasm target/wasm32v1-none/release/zkperp_vault.wasm --network testnet)
stellar contract invoke --id $VAULT_ID --network testnet -- upgrade --new_wasm_hash $HASH
stellar contract invoke --id $VAULT_ID --network testnet -- init_close \
  --close_vk "$(cd circuits && node scripts/vk-arg.mjs close_position)" --treasury_owner $TREASURY_OWNER_HASH
```

**All three open positions closed** through the relay server, at the
Chainlink mark price 82,089.01 (entry 81,921.07):
```
closing #0 long 5,000:  profit 10.2500013, fees 10, payout 500.2500013  -> leaf 6, fee note leaf 7
closing #1 short 2,000: loss 4.1000006,    fees 4,  payout 391.8999994  -> leaf 8, fee note leaf 9
closing #3 short 3,000: loss 6.1500009,    fees 6,  payout 287.8499991  -> leaf 10, fee note leaf 11
```
#0 and #1 were opened publicly in step 4, #3 privately in step 6; the same
circuit closes both kinds.

| | Before | After |
|---|---|---|
| `live_positions` / `reserved` | 3 / 15,000 | **0 / 0** |
| `pool_value` | 20,030 | 20,030.0000002 (net PnL: −10.25 + 4.10 + 6.15, rounded in the pool's favour) |
| `trader_funds` | 1,700 | 1,699.9999998 |
| Token balance | 21,730 | 21,730 = `pool_value + trader_funds` ✓ |

Trader's notes afterwards (`scripts/notes.mjs`): 500, 500.25, 391.90 and
287.85 unspent (1,680). The treasury holds three fee notes (20) in the vault.
The keeper view shows all three positions as **CLOSED**.

## 7.8 What's public at a close

| | Visible? |
|---|---|
| Which position closed | No: only a nullifier (unlinkable to its open) |
| Who closed it | No: the relayer submits |
| Payout amount, fees | No: private notes |
| **PnL** (`pool_in` / `pool_out`) and the exit price | **Yes**, as on Midnight: the pool's change is public |
| Direction | Partly: profit or loss, together with the public price move, suggests long or short. A flat close shows nothing. |
| Size | Partly: PnL ÷ price move ≈ size, if an observer guesses the entry price from the price history (Midnight has the same leak). Hidden pool accounting with per-epoch totals (ARCHITECTURE §8) removes it. |
| A capped profit | Shows that the cap bound (`pool_out = max_payout`) |

## 7.9 Not built yet

- **Treasury collection:** fee notes accumulate in the vault, owned by the
  treasury. Paying them to LPs, like Midnight's `depositFees`, needs a way to
  merge notes first; withdrawing one at a time would reveal each position's
  fees.
- **Borrow fee** (§7.2).
- **Liquidation** by keepers: built in step 8 (`docs/8_liquidation.md`).
- **Relayer fee** from the payout note.
