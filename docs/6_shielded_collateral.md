# 6. Shielded collateral (private notes)

Step 4 opened positions with a **public** collateral transfer, so the
collateral amount and the trader's address were on-chain. Step 6 moves trader
funds into **private notes** inside the vault. A position opened from a note
shows neither the collateral nor the trader:

| | Step 4 `open_position` | Step 6 `open_position_private` |
|---|---|---|
| Direction, size, leverage, fee | hidden | hidden |
| Collateral amount | **public** (token transfer) | hidden |
| Trader's account | **public** (transfer + tx source) | hidden (a relayer submits) |
| Which deposit funded it | — | hidden (only a nullifier is published) |

This matches what zkperp-midnight gets from Midnight's shielded pUSDC coins.
On Stellar the token balances are public, so the shielding happens inside the
vault, as notes in its commitment tree. Step 4's public open stays available.

## 6.1 Design

```
deposit_note (public)          open_position_private (private)        withdraw_note (public payout)
──────────────────────         ───────────────────────────────        ─────────────────────────────
trader → vault: amount         relayer submits proof:                 relayer submits proof:
vault inserts note             • spends a note (nullifier)            • spends a note (nullifier)
  Poseidon(amount, inner)      • inserts position commitment          • pays amount → recipient
                               • inserts change note                  • inserts change note
```

**Note**, held privately by its owner:
```
ownerHash  = Poseidon(ownerSecret)
inner      = Poseidon(ownerHash, salt)        ← the depositor sends this
commitment = Poseidon(amount, inner)          ← the vault computes this itself
nullifier  = Poseidon(salt, leafIndex)        ← published when the note is spent
```
- The vault hashes the deposited `amount` into the commitment itself, so a
  depositor can't create a note worth more than they paid.
- Notes and positions share **one commitment tree**. Leaf indices are unique,
  so nullifiers are too. Positions opened from a note are owned by the same
  `ownerHash`.
- **No extra secret to keep:** a trader's `ownerSecret` is derived from their
  Stellar secret in `.env`: `sha256("zkperp-owner:" + <ROLE>_SECRET) >> 8`.
  Only each note's random `salt` is stored, in `.zkperp/notes/`.

**Relayer.** Private opens and withdrawals move no tokens out of the trader's
account, so the trader doesn't need to sign. The proof is the only authority.
Any account can submit it, and a **relayer** does, so the trader's address
never appears. The relayer can't change anything, because the proof binds
every value: for withdrawals that includes the amount and the recipient. It
can only refuse. For the hackathon the relayer pays the fees itself.

**Leaves on-chain.** Every leaf is stored in the vault (`leaves(start,
count)`), so traders build Merkle paths from the contract rather than from
events (testnet RPC keeps events only ~16 hours), and check the rebuilt root
with `is_known_root`. That's the indexer-independence rule from ZKELLA's
design.

## 6.2 Circuits

| Circuit | Constraints | Public inputs | Outputs | Proves |
|---|---|---|---|---|
| `open_private.circom` | ~26,300 | `root`, `entryPrice`, `openTime`, `feeBps`, `keeperPk` | `nullifier`, `commitment`, `changeCommitment`, `noteR`, `note[8]` | The note is in the tree and owned by the prover; collateral ≤ note amount; change = the rest, to the same owner; plus every step-4 rule (fee, 1×–20× leverage, commitment, verifiable keeper note) |
| `withdraw_note.circom` | ~13,600 | `root`, `amount`, `recipient` | `nullifier`, `changeCommitment` | The note is in the tree and owned; amount ≤ note amount; change = the rest. The recipient is bound into the proof. |

Shared templates in `notes.circom`: `NoteCommitment`, `MerkleRoot` (depth 20,
which also yields the leaf index) and `SpendNote`.

`recipient` is a field derived from the address: the first 31 bytes of
`sha256(xdr(ScVal::Address))`. JS (`lib/notes.mjs`) and the vault
(`recipient_digest`) compute the same value; a test checks they match.

**Trusted setup:** single-party, Powers of Tau **2^15** (open_private needs
more than 2^14 constraints):
`scripts/setup.sh open_private 15 && scripts/setup.sh withdraw_note 15`
(about 2 minutes). Proving takes about 1.1 s for `open_private`.

## 6.3 Contract (`contracts/zkperp-vault/src/notes.rs`)

| Function | Auth | Description |
|---|---|---|
| `init_notes(open_private_vk, withdraw_vk)` | admin, once | Turns on notes (after `init_perp`) |
| `set_note_vks(open_private_vk, withdraw_vk)` | admin | Replace both keys after a new setup |
| `deposit_note(from, amount, inner) → leaf` | `from` | Public transfer in; inserts `Poseidon(amount, inner)`. Event `NoteDeposited { leaf_index, commitment, amount, root }`. |
| `open_position_private(root, nullifier, commitment, change, note_r, note, open_time, proof) → leaf` | **none** | Same checks as `open_position` (time, price freshness, room for `max_payout`, inputs `< r`), plus: root is recent, nullifier unused. Inserts the position (returned leaf) and the change note (next leaf). Event `PrivateOpened` (no amounts). |
| `withdraw_note(root, nullifier, amount, recipient, change, proof) → leaf` | **none** | Pays `amount` to `recipient`; inserts the change note. Event `NoteWithdrawn { nullifier, amount, recipient, change_leaf, change_commitment, root }`. |
| `is_spent(nullifier)`, `recipient_digest(address)` | — | Views |
| `leaves(start, count)` | — | Stored leaves (max 200 per call) |
| `backfill_leaves(start, leaves)` | admin | Stores leaves inserted before leaf storage existed. Only fills missing indices inside the tree. A wrong value can't move funds; it only breaks paths, because clients check the root. |

Also changed:
- `collateral_held()` is now **`trader_funds()`**: everything traders own in
  the vault (notes + position collateral). A private open moves value from a
  note to a position without changing the total, so the vault's token balance
  is always `pool_value + trader_funds`.
- Shared open checks moved into `check_open` (used by both opens).
- Nullifiers are persistent entries extended to ~173 days on every write. An
  archived entry makes the transaction fail until it's restored, so it never
  reads as "unspent".

Errors: `NoteSpent` (22), `UnknownRoot` (23), `NotesNotInitialized` (24),
`NotesAlreadyInitialized` (25).

## 6.4 Cost (compiled WASM)

| | Instructions | Share of 400M |
|---|---|---|
| `deposit_note` (transfer + on-chain Poseidon + 20-hash insert) | 26.7M | 6.7% |
| `open_position_private` (verify 19 inputs + 2 inserts) | **79.4M** | 19.9% |
| `withdraw_note` (verify 5 inputs + transfer + 1 insert) | 51.9M | 13.0% |
| `open_position` (step 4, for comparison) | 56.3M | 14.1% |

## 6.5 Tests

`cargo test -p zkperp-vault`: 9 note tests (37 vault tests in total), using
**real proofs from snarkjs** (`src/fixtures/notes.json`, written by
`circuits/scripts/notes-fixture.mjs`). The fixture follows a fresh vault
through: deposit (leaf 0) → private open (position leaf 1, change leaf 2) →
withdraw 100 from the change note.

| Test | Shows |
|---|---|
| `deposit_computes_the_note_commitment_on_chain` | The vault's `Poseidon(amount, inner)` equals JS's commitment (same root); the leaf is stored; `trader_funds` = 1,000 |
| `private_open_then_withdraw` | The open succeeds **with no auths at all**; no token moves; `trader_funds` unchanged; nullifier spent; root equals JS's; withdraw pays the bound recipient |
| `a_note_can_be_spent_once` | Second open or withdraw with the same note → `NoteSpent` |
| `relayer_cannot_redirect_or_change_a_withdrawal` | Different recipient or amount → `InvalidProof` |
| `tampered_keeper_note_is_rejected` | Verifiable encryption still holds |
| `unknown_root_is_rejected` | A root the vault never had → `UnknownRoot` |
| `recipient_field_matches_js` | Address → field identical in JS and Rust |
| `notes_admin_functions` | `init_notes` once; `backfill_leaves` fills only missing in-tree leaves; admin only |
| `wasm_note_costs` | §6.4 |

`cd circuits && npm test`: 3 new tests. Open from a note verifies, with the
right nullifier, change and keeper-readable position. Overspending, or
spending someone else's note, can't be proven. Withdraw verifies with the
right change and public signals.

## 6.6 Scripts (`circuits/`)

| Command | Does |
|---|---|
| `node scripts/note-deposit.mjs <amount> [ROLE]` | Deposits mUSDC as a note (signed by `<ROLE>_SECRET`, default `TRADER`); saves the note in `.zkperp/notes/` |
| `node scripts/notes.mjs [ROLE]` | Lists the role's notes and whether each is spent on chain |
| `node scripts/open-private.mjs <long\|short> <size> <collateral> [ROLE]` | Picks the smallest note that covers the collateral, rebuilds the tree from `leaves`, proves, relays; saves the position and the change note |
| `node scripts/withdraw-note.mjs <amount> <G…/C…/ROLE> [ROLE]` | Withdraws from a note to a public address, via the relayer |
| `node scripts/relay-server.mjs` | The relayer: `POST /relay {vault, fn, args}` for `open_position_private` / `withdraw_note` only, on `RELAYER_PORT` (3030), signed with `RELAYER_SECRET` |
| `node scripts/keeper-read.mjs` | Now also decrypts `PrivateOpened` events |

The client scripts post to the relay server when `RELAYER_URL` is set (for
example `http://127.0.0.1:3030`). Otherwise they submit with `RELAYER_SECRET`
directly, the same transaction the server would send.

New in `.env`: `RELAYER_ADDRESS` / `RELAYER_SECRET` (a new account, funded by
Friendbot) and `RELAYER_PORT`.

## 6.7 Testnet (2026-10-16)

**Upgrade of the real vault** `CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE`:

| Step | Result |
|---|---|
| `upload` + `upgrade` (`ADMIN_SECRET`) | WASM hash `5889b0b424fa7131a78f15e0cd6528b2d0def6247c6d7b4e5e33a44f8052273e` (46.6 KB, 38 functions). Address, balances, positions kept. |
| `init_notes` | `open_private` and `withdraw_note` verification keys |
| `backfill_leaves(0, [#0, #1])` | The two step-4 positions (inserted before leaf storage) from `.zkperp/positions/`; rebuilt root is known to the vault ✓ |

```sh
set -a; . ./.env; set +a
export STELLAR_ACCOUNT="$ADMIN_SECRET"
HASH=$(stellar contract upload --wasm target/wasm32v1-none/release/zkperp_vault.wasm --network testnet)
stellar contract invoke --id $VAULT_ID --network testnet -- upgrade --new_wasm_hash $HASH
stellar contract invoke --id $VAULT_ID --network testnet -- init_notes \
  --open_private_vk "$(cd circuits && node scripts/vk-arg.mjs open_private)" \
  --withdraw_vk "$(cd circuits && node scripts/vk-arg.mjs withdraw_note)"
```

**End-to-end run** (relay server running, `RELAYER_URL=http://127.0.0.1:3030`):
```
$ node scripts/note-deposit.mjs 1000
deposited 1000 as note at leaf 2
$ node scripts/open-private.mjs short 3000 300
proved in 1.1 s; relaying...
opened private position #3 (short); change note 700 at leaf 4
$ node scripts/withdraw-note.mjs 200 TRADER
withdrew 200 to GDPN…NJHY; change note 500 at leaf 5
$ node scripts/notes.mjs
leaf   5  500 mUSDC  unspent
leaf   4  700 mUSDC  spent (withdraw 200)
leaf   2  1,000 mUSDC  spent (open #3)
```
Relay server log: `open_position_private -> 3`, `withdraw_note -> 5`.

**What the chain shows** (events + Horizon):

| Ledger | Event | Public |
|---|---|---|
| 5227356 | `NoteDeposited` | leaf 2, amount **1,000**, from the trader's account |
| 5227360 | `PrivateOpened` | leaf 3, commitments, nullifier, keeper note. **No amount.** Transaction source: the **relayer** (`GAXI…JXFG`), not the trader. |
| 5227362 | `NoteWithdrawn` | amount 200, recipient, nullifier. Not linked to leaf 2 or 4. |

(This demo withdrew to the trader's own address, which links them on purpose;
a real withdrawal would go to a fresh address.)

**Oracle failover, tested live in the same run** (completes step 5 §5.7): only
signers 2 and 3 were running when Chainlink published round `…495`. Signer 2
submitted it with signatures 2+3 after its 20 s turn (BTC/USD 82,089.01);
signer 3's later attempt failed with `StaleRound` (#20), as designed. Signer
2's first attempt failed too, and the error wasn't captured (the relayer
logged the CLI's first output line); the relayer now logs the actual error
line.

## 6.8 What still leaks

| | Visible? | Mitigation |
|---|---|---|
| Deposit amount, depositor, time | **Yes** (as LP deposits, and as on Midnight) | — |
| Withdraw amount, recipient, time | **Yes** | Withdraw to fresh addresses |
| Link deposit → open | Only by **amount or timing** | Deposit round amounts (100 / 1,000 / 10,000), open with different amounts, wait between steps |
| Small anonymity set | On a hackathon testnet with a few users, timing may link actions | Volume |
| Number of open positions, entry price (mark price) | Yes | As step 4 / Midnight |
| Everything about a position, to keepers | Yes (keeper note), including the owner hash | Trust assumption (ARCHITECTURE §1) |
| Relayer sees the proof before it's on-chain | It learns nothing private, and can only refuse | Several relayers; or anyone can relay |

## 6.9 Next

- **Close** a position: built in step 7 (`docs/7_close_position.md`).
- **Liquidation** by keepers, using the keeper note.
- A relayer fee taken from the note inside the proof, so relayers are paid
  without a link to the trader.
