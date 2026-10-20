# 9. Treasury: merging fee notes and paying keepers

Every close and liquidation leaves a **fee note** owned by the treasury
(steps 7 and 8). This step turns those notes into money: the treasury merges
them privately, then collects the total, which is split between the
**keepers** and the **LPs**.

Midnight does the same with `depositFees`: the treasury pays the LPs' share
(70% there) into the pool once per epoch, without minting shares.

## 9.1 Design

```
fee notes (private, treasury-owned)          collect_fees (public aggregate)
leaf 7: 10 ┐                                  ┌─ 30% → keepers, equal shares (claim_keeper_fees)
leaf 9:  4 ┴ merge → leaf 12: 14 ┐            │
leaf 11: 6 ──────────────────────┴ merge → leaf 13: 20 ─┤
                                              └─ 70% → pool_value (LP revenue, no shares minted)
```

- **`merge_notes`** joins two notes of the same owner into one (new circuit).
  It's general: traders can merge their own notes too. A merge shows nothing
  except two nullifiers and a new commitment.
- **`collect_fees`** spends a note with the existing **withdraw proof**
  (step 6), but the bound recipient is the **vault itself**, so the proof
  can't be redirected. Only the collected total is public, and it's an
  aggregate over many positions. Collecting one fee note at a time would
  reveal each position's fees, and so its size; that's why merging comes
  first.
- **Split:** `keeper_share_bps` (30%) is divided equally among the registered
  keepers (step 8) and credited to them. The rest is added to `pool_value`
  without minting shares, so every zLP share gains value. Rounding goes to the
  pool.
- **`claim_keeper_fees`**: a keeper signs and receives its credit in mUSDC.
- **Bookkeeping:** the vault now has three buckets:
  `token balance = pool_value + trader_funds + keeper_owed_total`.

**How the treasury finds its fee notes.** A fee note's salt is
`Poseidon(position salt, 1)`, and its amount follows from the position and the
public exit price. The treasury runs with the keeper view key, so it decrypts
every position. For each `PositionClosed`/`PositionLiquidated` event it
recomputes the fee amount with the step-7/8 settlement code, and checks it
against the event's fee commitment. Only an exact match is accepted.

## 9.2 Circuit `circuits/merge_notes.circom`

About 26,000 constraints, 2^15 single-party setup
(`scripts/setup.sh merge_notes 15`).

| | Signals |
|---|---|
| Public input | `root` |
| Private | owner secret; both notes' amount, salt and Merkle path; the merged salt |
| Outputs | `nullifierA`, `nullifierB`, `merged` = Poseidon(a + b, Poseidon(ownerHash, mergedSalt)) |

It proves both notes are in the tree and owned by the same secret. Using the
same note twice gives two equal nullifiers, and the vault rejects the second.

## 9.3 Contract (`contracts/zkperp-vault/src/treasury.rs`)

| Function | Auth | Description |
|---|---|---|
| `init_treasury(merge_vk, keeper_share_bps)` | admin, once (after `init_liquidation`) | |
| `set_treasury_config(merge_vk, keeper_share_bps)` | admin | |
| `merge_notes(root, nullifier_a, nullifier_b, merged, proof) → leaf` | none | Event `NotesMerged` |
| `collect_fees(root, nullifier, amount, change, proof) → change leaf` | none | Withdraw proof with recipient = this vault. Event `FeesCollected { amount, to_pool, per_keeper, … }` |
| `claim_keeper_fees(keeper) → amount` | keeper | Pays the keeper's credit. Event `KeeperPaid` |
| `keeper_owed(keeper)`, `keeper_owed_total()`, `keeper_share_bps()` | — | Views |

New errors: `TreasuryNotInitialized` (32), `TreasuryAlreadyInitialized` (33).

## 9.4 Tests

- JS (`test/merge.test.mjs`): a merge verifies and sums correctly; a note
  with a different owner can't be merged.
- Rust (5 tests, real proofs from `scripts/treasury-fixture.mjs`; 56 vault
  tests in total):
  - **merge then collect:** 30 + 12 merged with no signature; 42 collected →
    4.2 per keeper ×3, 29.4 to the pool; balance = pool + funds + owed;
  - **keepers claim** their share; claiming again → `InvalidAmount`;
  - **notes spend once**: a second merge or collect → `NoteSpent`;
  - **the collected amount is bound** by the proof (41 instead of 42 →
    `InvalidProof`);
  - **admin:** `init_treasury` once; share above 100% rejected.

## 9.5 Scripts

| Command | Does |
|---|---|
| `node scripts/treasury.mjs` | Scans events, identifies and checks the treasury's fee notes, reports unspent ones and the keepers' credit. State in `.zkperp/treasury-<vault>.json` (gitignored). |
| `node scripts/treasury.mjs --collect` | Merges all unspent fee notes pairwise into one, then collects it |
| `node scripts/claim-keeper.mjs --keeper <n>` | Claims keeper n's credit (adds the account's mUSDC trustline first if missing) |

`deploy-vault.mjs` now also runs `init_treasury` (`KEEPER_SHARE_BPS`, default
3000). The treasury uses `TREASURY_OWNER_SECRET`, `TREASURY_OWNER_HASH` and
`KEEPER_VIEW_SK` from `.env`; merges and collections are submitted by the
relayer account.

## 9.6 Testnet (2026-10-16, real vault)

`CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE` upgraded (WASM hash
`a0e700d53697de104f7b616bf5c8559b2efe46e720c1a6919f5b46a1ca8b95cc`, 62 KB,
55 functions) and `init_treasury(merge_vk, 3000)`. Then the fee notes from
step 7's three closes:

```
$ node scripts/treasury.mjs --collect
[treasury] unspent fee notes: leaf 7 (10), leaf 9 (4), leaf 11 (6); total 20
[treasury] merged leaf 7 + leaf 9 -> leaf 12 (14)
[treasury] merged leaf 12 + leaf 11 -> leaf 13 (20)
[treasury] collected 20 from leaf 13 (change note leaf 14); owed to keepers now 6
$ node scripts/claim-keeper.mjs --keeper 1
keeper 1: added mUSDC trustline
keeper 1 claimed 2 mUSDC
```

| | Before | After |
|---|---|---|
| `pool_value` | 20,030.0000002 | 20,044.0000002 (+14 LP revenue) |
| `trader_funds` | 1,699.9999998 | 1,679.9999998 (−20 fee notes) |
| `keeper_owed_total` | 0 | 4 (6 credited, keeper 1 claimed 2) |
| Token balance | 21,730 | 21,728 = 20,044 + 1,680 + 4 ✓ (2 paid out to keeper 1) |

The first claim attempt failed because keeper 1 had no mUSDC trustline (SAC
error #13). The claim script now adds it automatically.

## 9.7 Privacy

| | |
|---|---|
| Individual fee notes, merges | Private (only nullifiers and commitments) |
| A collection's total | Public. With few positions per collection it narrows down their fees (and sizes), so collect rarely (per epoch) and over many positions |
| Keepers' credit and claims | Public (keepers are known operators) |
