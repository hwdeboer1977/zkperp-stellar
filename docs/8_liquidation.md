# 8. Liquidation by keepers

A position whose equity falls below the **maintenance margin** is closed by a
keeper, without its owner. Three keepers (ARCHITECTURE §3) each read every
position from the keeper notes written at open (steps 4 and 6). Any one of
them can liquidate. The loss goes to the pool, the remaining equity goes back
to the owner as a private note, and the fees go to the treasury.

This is the Soroban counterpart of `liquidatePosition` and
`services/keeper/keeper.ts` in zkperp-midnight, with the same parameters:
maintenance **250 bps**, liquidation fee **50 bps**.

## 8.1 Rules

Settlement is a close (step 7) at the mark price, plus:

| Rule | Detail |
|---|---|
| Only a loss or a flat position | A position in profit can't be liquidated (in the circuit: `isProfit × pnl = 0`) |
| **Below maintenance** | `equity × 10000 < size × maintenance_bps`, where equity = collateral − loss − closing fee |
| Liquidation fee | `ceil(size × liquidation_fee_bps / 10000)`, out of the equity (at most all of it) |
| Owner gets back | `equity − liquidation fee taken`, as a **private note** for the position's owner hash, salt `Poseidon(salt, 2)` |
| Treasury gets | `openFee + closing fee taken + liquidation fee taken`, as its note (salt `Poseidon(salt, 1)`, as for a close) |
| Pool gets | the loss (`pool_in`), public |
| Who may liquidate | a **registered keeper account**, which must sign (`keeper.require_auth()`) |

Value is conserved: `collateral + openFee = back + fees + pool_in`.

**Differences from Midnight, on purpose:**
- **The keeper fee goes to the treasury, not to the keeper's wallet.** A
  public keeper fee equals 0.5% of size, so it would reveal the position's
  size. Keepers are paid from the treasury instead (ARCHITECTURE §3), and the
  treasury is run with the keeper view key.
- **The owner's remaining equity goes to a note that the owner can find
  alone.** The keeper doesn't know the owner secret, but it knows the owner
  *hash* and the salt (from the keeper note), so it creates the payout note
  for that hash with salt `Poseidon(salt, 2)`. The owner knows the same salt.
  The vault also keeps a record per liquidated position
  (`liquidation(nullifier)`: exit price, payout leaf), so the owner can rebuild
  the note without events.

At 20× leverage a position starts with 5% equity, which is above 2.5% (after
the 0.1% fees), so a fresh position is never liquidatable immediately. A test
confirms this.

## 8.2 Circuit `circuits/liquidate_position.circom`

About 17,000 constraints. Trusted setup 2^15, single-party:
`scripts/setup.sh liquidate_position 15`.

| | Signals |
|---|---|
| Public inputs | `root`, `exitPrice` (mark), `liqTime`, `feeBps`, `treasuryOwner`, `maintenanceBps`, `liqFeeBps` |
| Private inputs | the 8 position fields from the keeper note (**owner hash**, not owner secret), Merkle path, `pnl`, `closeFee`, `liqFee` |
| Outputs | `nullifier`, `payoutCommitment`, `feeCommitment`, `poolIn` |

It proves:
- the position is in the tree (identified by its commitment, which includes the owner hash);
- the liquidation is not dated before the open;
- every fee is exact;
- the loss is exact (or the position is flat);
- the position is **below maintenance**;
- the settlement amounts are right.

## 8.3 Contract (`contracts/zkperp-vault/src/liquidate.rs`)

| Function | Auth | Description |
|---|---|---|
| `init_liquidation(liquidate_vk, config)` | admin, once (after `init_close`) | `config = { keepers: [Address], maintenance_bps, liquidation_fee_bps }` |
| `set_liquidation_config(liquidate_vk, config)` | admin | Replace the keepers, the margins or the key |
| `liquidate(keeper, root, nullifier, payout, fee, pool_in, liq_time, proof) → leaf` | **keeper** | Returns the owner's payout note leaf; the fee note is next |
| `liquidation(nullifier)` | — | `{ exit_price, payout_leaf, time }` for a liquidated position |
| `liquidation_config()` | — | View |

Checks in `liquidate`:

| Check | Error |
|---|---|
| `keeper` signed and is registered | auth error / `NotAKeeper` (31) |
| Liquidation initialized | `LiquidationNotInitialized` (29) |
| `liq_time` within 300 s of the ledger, not in the future | `BadCloseTime` (28) |
| Mark price fresh; root recent; `0 ≤ pool_in < 2^63`; inputs `< r` | as for a close |
| Proof verifies against the mark price, fee rate, treasury and **margins from storage** | `InvalidProof` (17) |
| Position not closed before | `NoteSpent` (22) |

Then:
- `live_positions − 1`;
- `pool_value += pool_in` and `trader_funds −= pool_in`;
- insert the payout and fee notes;
- store the liquidation record;
- emit `PositionLiquidated { nullifier, keeper, exit_price, pool_in, payout_leaf, payout_commitment, fee_leaf, fee_commitment, root }`.

## 8.4 Cost (compiled WASM)

| | Instructions | Share of 400M |
|---|---|---|
| `liquidate` | **77.0M** | 19.2% |

## 8.5 Keeper service (`circuits/scripts/keeper.mjs`)

```sh
cd circuits
node scripts/keeper.mjs --keeper 1      # and --keeper 2, --keeper 3, each in its own terminal
```

- **Reads positions:** fetches `PositionOpened` and `PrivateOpened` events,
  decrypts each keeper note with `KEEPER_VIEW_SK`, and keeps the plaintext in
  `.zkperp/keeper-<n>-<vault>.json` (gitignored, mode 600; it holds every
  position). Because it persists, positions survive beyond RPC's ~16-hour
  event window, as long as the keeper runs at least that often.
- **Each tick** (10 s, `KEEPER_TICK_MS`):
  - drops positions that are closed (it knows the salt, so it checks the
    nullifier);
  - checks every remaining position against the mark price;
  - for one below maintenance, builds the tree from `leaves`, proves and
    submits `liquidate`, signed with `KEEPER_<n>_SECRET`.
- **Stagger, as on Midnight:** keeper *n* acts once a position has been due for
  (n − 1) × 20 s (`KEEPER_STAGGER_MS`). Normally keeper 1 liquidates; if it is
  down, keeper 2, then keeper 3. Duplicates fail on chain (`NoteSpent`).
- Refuses to start if its account isn't a registered keeper of the vault.

**The owner's side:** `node scripts/positions.mjs` notices when one of the
owner's positions was liquidated. It sees the nullifier spent, reads
`liquidation(nullifier)`, recomputes the settlement, and saves the payout note
to the owner's wallet (`.zkperp/notes/`). It also flags open positions that
are **BELOW MAINTENANCE**.

**Deploy a full vault in one command:** `node scripts/deploy-vault.mjs` deploys
the vault and runs `init_perp`, `init_notes`, `init_close` and
`init_liquidation` from `.env` and `circuits/keys/`. Use it after a testnet
reset.

## 8.6 Keepers' accounts

`soroban-enable`'s `DEMO_SIGNER1..3` were planned as keepers (step 1), but
their secrets weren't in `.env`, so three new keeper accounts were generated
and funded with Friendbot:

| `.env` names | Address |
|---|---|
| `KEEPER_1_ADDRESS`, `KEEPER_1_SECRET` | `GABJKOF2WNYTSTBA5CTL7QQFXFAYV7BULARFFF2QLHIREWZQRQLWTDQU` |
| `KEEPER_2_ADDRESS`, `KEEPER_2_SECRET` | `GDEZ54HWJVBYDNQYQHMDBOLVEZX5CWSSZMAPGL4ICV5L6D4VTWKSK7G7` |
| `KEEPER_3_ADDRESS`, `KEEPER_3_SECRET` | `GC7NSZPPYPQDNMY3RRNIE7E5WH3N3RDDQRHKIHZEFJVO3I4YV5HUVRXE` |

To use other accounts, put their secrets in `.env` and register them with
`set_liquidation_config`. Keepers only pay XLM fees; they never hold mUSDC.

## 8.7 Tests

**Circuit** (`npm test`, 3 new; 12 in total):

| Scenario | Result |
|---|---|
| 10× long (4,000 / 396), −8% | loss 320, equity 72 < 100 → liquidated: fee 20, owner gets 52, as a note the owner can recompute |
| 10× short, +12.5% | loss takes all collateral: owner gets 0, no liquidation fee left |
| Same long at −2% (equity 316) | **can't be proven** |
| In profit | **can't be proven** |
| Flat at 20× | **can't be proven** (equity 4.9% > 2.5%) |

**Contract** (`cargo test -p zkperp-vault`, 7 new; 51 vault tests in total),
with real proofs (`src/fixtures/liquidate.json`, from
`scripts/liquidate-fixture.mjs`; the keeper's position comes from **decrypting
the keeper note**, as the service does):

| Test | Shows |
|---|---|
| `keeper_liquidates_below_maintenance` | The keeper signs; `pool_in` 320 to the pool; `live_positions` 0; no token moved; liquidation record; event |
| `only_registered_keepers_and_only_once` | A stranger → `NotAKeeper`; a second liquidation → `NoteSpent` |
| `keeper_must_sign` | Without the keeper's auth it fails |
| `liquidation_needs_the_crashed_price` | Price recovers before the proof lands → `InvalidProof` |
| `misstated_loss_is_rejected` | `pool_in − 1` → `InvalidProof` |
| `liquidation_admin` | Once; no empty keeper set; admin only |
| `wasm_liquidate_cost` | §8.4 |

## 8.8 Testnet (2026-10-16)

**Real vault** `CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE`
upgraded to step 8 (WASM hash
`ca22be0380df4c6a4dfbf1ee647db6fdcd77c91942dcbdcb62874168ade421c3`, 56.3 KB,
47 functions) and `init_liquidation` with the three keepers, 250 / 50 bps.
It runs on the live Chainlink price, so it is never given a fake crash.

**Liquidation demo vault**
`CDNKP3FFJWU5H46Y6FBVHELTUPQLWEQ2GOU4GMOCIM46AM3GEFSC33F2` (`LIQ_DEMO_VAULT_ID`
in `.env`), deployed with `deploy-vault.mjs`, using test prices from
`price.mjs`:

```
LP deposit 15,000; price 82,000
$ node scripts/note-deposit.mjs 1000
$ node scripts/open-private.mjs long 4000 400
opened private position #1 (long); change note 600 at leaf 2
(keepers 1, 2, 3 started)
$ node scripts/price.mjs 75000                                  # -8.5%
[keeper 1] new position #1: long 4,000 @ 82,000
[keeper 1] #1 is below maintenance at 75,000 (equity 50.54)
[keeper 1] liquidated #1: loss 341.46 to the pool, 30.54 back to the owner (note leaf 3)
[keeper 2] #1 is below maintenance at 75,000 (equity 50.54)
[keeper 2] #1 is closed
[keeper 3] #1 is below maintenance at 75,000 (equity 50.54)
[keeper 3] #1 is closed
$ node scripts/positions.mjs
#1 private LONG  size 4,000 @ 82,000  LIQUIDATED at 75,000, payout 30.54
$ node scripts/notes.mjs
leaf   3  30.537 mUSDC  unspent      <- recovered by the owner alone
leaf   2  600 mUSDC  unspent
```

Check: loss `ceil(4,000 × 7,000 / 82,000)` = 341.4634147; equity 396 − 341.46 −
4 = 50.54 < 100; liquidation fee 20; back 30.54. Afterwards: `pool_value`
15,341.46, `trader_funds` 658.54 (630.54 trader notes + 28 treasury fees),
token balance 16,000 = pool + trader funds ✓.

The first attempt of this run hit a transient RPC error (`Connection reset by
peer`) while setting the price. `lib/stellar.mjs` now retries network errors
up to 3 times; a duplicate vault call is harmless (it fails on chain).

## 8.9 Trust and privacy

| | |
|---|---|
| Keepers see every position (size, direction, collateral, entry, owner hash) | By design (ARCHITECTURE §1), as on Midnight |
| Keepers can't liquidate a healthy position | The proof requires equity below maintenance at the signed mark price |
| Keepers can't take funds | Payout to the owner's hash, fees to the treasury, loss to the pool: all fixed by the proof |
| Which keeper liquidated | Public (`keeper` in the event); keepers are known operators |
| A liquidation's loss and exit price | Public, like a close's PnL |
| If all three keepers are down | Positions below maintenance stay open, and the pool's risk grows (bad debt beyond the collateral isn't possible: the loss is capped at the collateral, and the pool only receives it) |

## 8.10 Not built yet

- Paying keepers from the treasury's fee notes (needs note merging, see step 7).
- Borrow fee (step 7).
- Trigger orders (stop loss / take profit) and limit orders executed by
  keepers, as on Midnight.
