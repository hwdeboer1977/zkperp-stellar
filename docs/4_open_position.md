# 4. Open a long or short position

A trader opens a private long or short against the LP vault (step 3). On-chain
an observer sees **that** a position was opened, and how much collateral was
transferred. They don't see the direction, size, leverage, opening fee or owner.
A note encrypted to the keepers lets any keeper read the position so it can be
liquidated later.

This is the Soroban counterpart of `openPosition` + `sizing` in
`~/zkperp-midnight/contracts/zkperp.compact`.

## 4.1 Decisions for the hackathon

| Choice | Decision | Differs from ARCHITECTURE.md |
|---|---|---|
| Collateral | **Public transfer** from the trader in the open transaction | Yes: shielded collateral notes come later |
| Price | **On-chain mark price**; the trader proves against it in one step. Step 4 started with a temporary mock key; the price now comes from the **2-of-3 signed Chainlink oracle in step 5** (`docs/5_price_oracle.md`) | Yes: §7 plans two-step keeper execution with a pull oracle |
| Merkle tree | **On-chain insertion** with the Poseidon host function | Yes: §6 plans a pending queue + keeper `insert_batch` |
| Keeper note | **In the open circuit**: BabyJubJub ECDH to the keeper view key, proven correct | No (§5) |

These keep step 4 to one circuit and one transaction. Each deviation is listed
again in §4.9 with what it costs in privacy or scale.

## 4.2 Flow

```
trader (local)                                   vault (on-chain)
──────────────                                   ────────────────
read mark_price, perp_config
choose long/short, size, collateral
prove open_position  (~1.3 s, snarkjs)
open_position(trader, collateral, open_time, ──▶ check open_time, price freshness, room
              commitment, note_r, note, proof)    check every public input < r
                                                  verify Groth16 proof (VK in storage)
                                                  transfer collateral trader → vault
                                                  live_positions += 1 (reserves max_payout)
                                                  insert commitment into Merkle tree
                                              ◀── emit PositionOpened(leaf, commitment, root, note)
save .zkperp/positions/<vault>-<leaf>.json
(owner secret + salt: needed to close)
```

## 4.3 Circuit `circuits/open_position.circom`

About 12,700 constraints (9,544 non-linear). Built from circomlib 2.0.5 parts
(Poseidon, BabyJubJub, comparators).

| | Signals |
|---|---|
| Public inputs | `collateral` (gross), `entryPrice` (= mark price), `openTime`, `feeBps`, `keeperPk[2]` |
| Private inputs | `isLong`, `size`, `openFee`, `ownerHash` = Poseidon(ownerSecret), `salt`, `ephemeral` |
| Outputs (public) | `commitment`, `noteR[2]`, `note[8]` |

What it proves:
1. `isLong` is 0 or 1. All amounts, the price and the time fit in 64 bits, so
   nothing can wrap around the field.
2. **Fee:** `openFee = ceil(size × feeBps / 10000)`, exactly.
3. **Fee fits:** `openFee < collateral`. Net collateral = `collateral − openFee`.
4. **Leverage:** `net ≤ size ≤ 20 × net` (1×–20×, as on Midnight).
5. **Commitment** = Poseidon(isLong, size, net, entryPrice, openTime, openFee,
   ownerHash, salt).
6. **Keeper note:** `R = e·Base8`, `S = e·keeperPk`, and
   `note[i] = field[i] + Poseidon(S.x, i)` for the same 8 fields, with `e ≠ 0`.
   A keeper computes `S = sk·R` and subtracts the pads. Because the circuit
   proves this, a trader can't post a note that keepers can't read.

The 17 public signals, in order, are the 11 outputs followed by the 6 inputs.
The vault rebuilds exactly this list.

Longs and shorts prove the same circuit with the same public shape, so a
transaction doesn't reveal its direction.

`salt` doubles as the **position secret**: closing (later) publishes the
nullifier Poseidon(salt, leaf_index), which the keeper can also compute because
the salt is in the note.

## 4.4 Trusted setup (single-party, hackathon only)

`circuits/scripts/setup.sh open_position` runs a local Powers of Tau at 2^14,
then the circuit's phase 2, in about 1 minute. Output in `circuits/keys/`:
`open_position.zkey` (proving key, 6.3 MB), `open_position.wasm` (witness
generator) and `open_position.vkey.json` (verification key).

> ⚠️ Whoever runs a single-party setup can forge proofs. Production needs a
> multi-party ceremony (ARCHITECTURE §15). If the setup is re-run, the new
> verification key must be installed with `set_open_vk` (admin).

## 4.5 Contract changes (`contracts/zkperp-vault`)

New code, added to the same contract (the real vault gets it through
`upgrade`, §4.8):
- `src/perp.rs`: configuration, mark price, `open_position`
- `src/merkle.rs`: an incremental depth-20 Poseidon(2) tree, compatible with
  circomlib, keeping the last 32 roots

| Function | Auth | Description |
|---|---|---|
| `init_perp(config, open_vk)` | admin, once | Turns on trading. `config` = `{signers, keeper_key {x,y}, fee_bps, max_price_age}`; `signers` are the step-5 oracle keys |
| `set_open_vk(open_vk)` | admin | Replaces the circuit's verification key (after a new setup) |
| `set_price(...)`, `mark_price()` | — | The mark price: see step 5 |
| `open_position(trader, collateral, open_time, commitment, note_r, note, proof) → leaf` | trader | See §4.2 |
| `perp_config()`, `trader_funds()` (was `collateral_held`), `merkle_root()`, `is_known_root(root)`, `position_count()` | — | Views |

Checks in `open_position`, in order:

| Check | Error |
|---|---|
| Trading is initialized | `PerpNotInitialized` (9) |
| `0 < collateral < 2^63` | `InvalidAmount` (1) |
| `open_time ≤ now` and `now − open_time ≤ 300 s` | `BadOpenTime` (14) |
| Price set and younger than `max_price_age` | `NoPrice` (11) / `StalePrice` (12) |
| `pool_value > (live_positions + 1) × max_payout` | `NoRoomForPosition` (15) |
| `note` has 8 fields | `InvalidNote` (18) |
| Every public input is `< r` (the SDK would silently reduce it) | `NotInField` (16) |
| Groth16 proof verifies against the price, fee rate and keeper key **from storage** | `InvalidProof` (17) |

Trader collateral is tracked separately from `pool_value` (since step 6:
`trader_funds()`, notes + position collateral), so LPs can never withdraw it.
The token balance equals `pool_value + trader_funds`.

Shared code moved into library crates so every contract can use it without
pulling another contract's exports into its WASM:
- `crates/zkperp-poseidon`: Poseidon, Merkle zero hashes, the generator script
- `crates/groth16`: verification with MSM

## 4.6 Cost (compiled WASM)

| | Instructions | Share of 400M |
|---|---|---|
| `open_position`, complete (verify 17 inputs + 20-hash Merkle insert + transfer + storage) | **56.1M** | 14% |

On-chain insertion is cheaper than ARCHITECTURE §12 estimated (~60M for the
tree alone), because the Poseidon constants are converted once per insertion
instead of once per hash. Proving takes about 1.3 s on this machine.

## 4.7 Tests

`cargo test -p zkperp-vault` (11 trading tests, plus the 9 LP tests from step
3). They use a **real proof from snarkjs** (`src/fixtures/open.json`, written
by `circuits/scripts/fixture.mjs`):

| Test | Shows |
|---|---|
| `opens_a_position_with_a_real_proof` | Leaf 0, `live_positions` 1, collateral moved and tracked separately from `pool_value`, event emitted, **Merkle root equals circomlibjs's** |
| `price_moved_since_proving_is_rejected` | Price is bound to the proof |
| `tampered_keeper_note_is_rejected` | Verifiable encryption: a garbled note fails |
| `different_collateral_than_proven_is_rejected` | Paying 1 unit less fails |
| `non_canonical_input_is_rejected` | `commitment + r` → `NotInField` |
| `timing_and_price_freshness_are_enforced` | Future, too-old and stale-price opens fail |
| `pool_must_back_max_payout` | Exactly one `max_payout` of liquidity is not enough |
| `open_reserves_liquidity_against_lp_withdrawals` | LPs can't pull the reserve |
| `init_perp_is_admin_only_and_once` | Plus `set_open_vk` auth |
| `merkle_tree_matches_circomlibjs` | Roots after 1, 2, 3 leaves match JS |
| `wasm_open_cost` | §4.6 |

`cd circuits && npm test` (3 tests): long and short proofs verify and keepers
decrypt them to the committed fields; a different key can't read a note; 21×
and 0.5× leverage can't be proven.

## 4.8 Testnet

### Dry run (done, 2026-10-16)

A separate vault was deployed with the test account as admin and as the
temporary mock oracle, so the scripts could be tested end to end without the
admin key. (It runs step-4 code with the mock price. Step 5 tested the same
flow at a live Chainlink price on dry-run vault v2.)

| | Value |
|---|---|
| Dry-run vault | `CBAODOWDEEIMLA6NCEOZWIJTYGFXM6YODZ4OXT6JPUQT3DPHMDSAZYZT` |
| Liquidity | 15,000 mUSDC (from the test trader account, `TRADER_*`) |
| Mark price | 60,000 (`600000000000`) |
| `fee_bps` / `max_price_age` | 10 / 86,400 s |

```
$ node scripts/open.mjs long 5000 500
proved in 1.3 s; submitting...
opened position #0 (long)
$ node scripts/open.mjs short 2000 400
opened position #1 (short)
$ node scripts/keeper-read.mjs
#0 LONG  size 5,000  collateral 495  entry 60,000  fee 5  leverage 10.10x  commitment matches
#1 SHORT size 2,000  collateral 398  entry 60,000  fee 2  leverage 5.03x  commitment matches
```
Vault afterwards: `live_positions` 2, `reserved` 10,000, `collateral_held` 900,
`pool_value` 15,000, `withdrawable` 4,999.9999999.

### The real vault (done, 2026-10-16)

`CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE` was upgraded to steps
4 + 5 together and now holds two positions (a long and a short) opened at the
live Chainlink price. Details and commands are in step 5, §5.7.

## 4.9 Keys and accounts

| Key / file | Role |
|---|---|
| Mock oracle key `GBE533KPSRSIWIEUHOIZ53K3HPEFDHHC5OEIGHGKANL7CAF42UVBQNUL` | Set the temporary mock price on the step-4 dry-run vault. **Retired**: step 5's signers (`ORACLE_1..3_*`) replace it. Not in `.env`. |
| `KEEPER_VIEW_SK`, `KEEPER_VIEW_PK_X/Y` in `.env` | Keepers' shared BabyJubJub view key (secret / public). Created by `scripts/keeper-key.mjs` (first kept in `.zkperp/keeper-view-key.json`, since moved to `.env`). Losing the secret makes every keeper note unreadable; the script refuses to overwrite it. |
| `.zkperp/positions/*.json` | Each position's private record (`ownerSecret`, `salt`, fields). Needed to close. Gitignored, mode 600. |

## 4.10 Scripts (`circuits/`)

| Command | Does |
|---|---|
| `npm install` | snarkjs 0.7.5, circomlib 2.0.5, circomlibjs 0.1.7 |
| `scripts/setup.sh open_position` | Compile + single-party setup → `keys/` |
| `node scripts/keeper-key.mjs` | Create the keeper view key into `.env` (`KEEPER_VIEW_SK`, `KEEPER_VIEW_PK_X/Y`), print its public half |
| `node scripts/vk-arg.mjs open_position` | Verification key as the vault's JSON argument |
| `node scripts/open.mjs <long\|short> <size> <collateral> [ROLE]` | Prove + submit an open, signed by `<ROLE>_SECRET` from `.env` (default `TRADER`); save the record. Uses `VAULT_ID` from `.env` (or the environment). |
| `node scripts/keeper-read.mjs [start-ledger]` | Fetch `PositionOpened` events and decrypt them with `KEEPER_VIEW_SK` |
| `node scripts/fixture.mjs <out.json>` | Regenerate the Rust test fixture |
| `npm test` | Circuit tests |

circom 2.2.2 is installed with
`cargo install --locked --git https://github.com/iden3/circom.git --tag v2.2.2 circom`.

## 4.11 What's public in this step

| | Visible on-chain? |
|---|---|
| Direction, size, leverage, opening fee, owner | **No** |
| That a position was opened, when, and its leaf index | Yes |
| Gross collateral and the trader's address (public token transfer) | **Yes.** That bounds the size to between ~1× and 20× of it. Step 6 (`open_position_private`, shielded notes) removes this. |
| Entry price | Yes, it's the public mark price at that moment (also true on Midnight) |
| Number of open positions (`live_positions`) | Yes, as on Midnight |

Other hackathon simplifications: the verification key can be replaced by the admin without a timelock; the
trusted setup is single-party; event history comes from RPC, which keeps it for
only ~16 hours on testnet.

## 4.12 Next

- Close a position (trader proves ownership + PnL against the mark price;
  nullifier; payout from the pool, freeing the `max_payout` slot).
- Liquidation by keepers using the note.
- Shielded collateral notes, so collateral and the trader's address are hidden
  too.
