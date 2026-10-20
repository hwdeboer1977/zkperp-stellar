# 13. Limit orders

A trader places a **limit long** that opens once the mark price is **at or
below** a limit, or a **limit short** at or above. The collateral waits in
escrow; a keeper opens the position when the limit is reached, and the owner
can cancel until then. The public sees neither the side, the size, the
collateral, nor the limit.

This is the Soroban counterpart of Midnight's `placeLimitOrder` /
`executeLimitOrder` / `cancelLimitOrder`.

## 13.1 How it works

```
place_limit (owner, relayed)        execute_limit (keeper)                 cancel_limit (owner, relayed)
spend a note ──▶ order commitment   limit reached? open at the MARK price   proof of ownership
               + change note        position salt = Poseidon(orderSalt, 4)  refund note, salt Poseidon(orderSalt, 5)
               + note to keepers
```

- **Order commitment** = `Poseidon(isLong, size, collateral, limit, ownerHash, orderSalt)`.
  Collateral is gross; the opening fee is taken at the fill.
- **Keeper note:** `[isLong, size, collateral, limit, ownerHash, orderSalt]`,
  verifiably encrypted (`seal.circom`).
- **Fill:** the keeper proves the order and the limit condition (long:
  mark ≤ limit; short: mark ≥ limit), and opens the position **at the mark
  price** under exactly the open rules of step 4: exact opening fee, net
  collateral > 0, leverage 1×–20×. The vault checks the price is fresh and that
  the pool can back one more `max_payout`.
- **No extra keeper note at the fill.** The position's salt is
  `Poseidon(orderSalt, 4)`, so every keeper (from the order note) and the owner
  (from their order record) rebuild the position from the fill record (leaf,
  entry price, open time). From then on it's an ordinary position:
  closable, liquidatable, and stop-loss / take-profit capable.
- **Escrow stays in `trader_funds`.** Placing, filling and cancelling move no
  tokens.
- An order that breaks the open rules (e.g. over 20× leverage) can never be
  filled; its owner cancels it.

## 13.2 Circuits

| Circuit | Constraints (non-linear) | Public | Outputs |
|---|---|---|---|
| `place_limit.circom` | ~15,000 | `root`, `keeperPk` | `nullifier`, `order`, `changeCommitment`, `noteR`, `note[6]` |
| `execute_limit.circom` | ~1,900 | `order`, `entryPrice` (mark), `openTime`, `feeBps` | position `commitment` |
| `cancel_limit.circom` | ~1,300 | `order` | `refund` (note commitment) |

Shared template `LimitCommitment` in `limit.circom`. 2^15 single-party setups.

## 13.3 Contract (`contracts/zkperp-vault/src/limits.rs`)

| Function | Auth | Description |
|---|---|---|
| `init_limits(place_vk, execute_vk, cancel_vk)` / `set_limit_vks` | admin | |
| `place_limit(root, nullifier, order, change, note_r, note, proof) → change leaf` | none | Spends the note, registers the order. Event `LimitPlaced`. |
| `execute_limit(keeper, order, commitment, open_time, proof) → position leaf` | keeper | Order must be open; `check_open` (time, fresh price, room); verifies against the mark price and fee rate from storage; `live_positions + 1`; stores the fill. Event `LimitFilled { order, keeper, leaf_index, commitment, entry_price, open_time }`. |
| `cancel_limit(order, refund, proof) → refund leaf` | none | Order must be open; the proof shows ownership. Event `LimitCancelled`. |
| `is_limit_open(order)`, `limit_fill(order)` | — | Views |

New errors: `LimitsNotInitialized` (38), `LimitsAlreadyInitialized` (39); reuses
`OrderExists` / `NoSuchOrder`.

## 13.4 Tests

**JS** (`test/limits.test.mjs`):
- a placement verifies, the change is right, and keepers decrypt the order;
- long and short fill only once the limit is reached, at the **mark** price,
  and the rebuilt position equals the proof's;
- a 100× order can't fill;
- only the owner can cancel, and the refund note matches.

**Rust** (`test_limits.rs`, real proofs from `scripts/limits-fixture.mjs`):
- **place, fill and cancel:** no signatures for place or cancel; escrow stays
  in trader funds; the fill makes a live position; fill record at leaf 3;
  refund at leaf 4;
- **fill rules:** before the limit → `InvalidProof`; non-keeper →
  `NotAKeeper`; twice → `NoSuchOrder`;
- **no double use:** double placement → `OrderExists`; cancelling unknown or
  already-cancelled orders → `NoSuchOrder`.

64 vault tests and 21 JS tests pass.

## 13.5 Scripts

| Command | Does |
|---|---|
| `node scripts/limit.mjs place <long\|short> <size> <collateral> <limit> [ROLE]` | Escrows from your smallest covering note; relays; keeps the record in `.zkperp/limits/` |
| `node scripts/limit.mjs cancel <order prefix> [ROLE]` | Cancels; saves the refund note |
| `node scripts/limit.mjs list` | Open / FILLED (→ position #) / cancelled |
| `node scripts/keeper.mjs --keeper n` | Now also syncs `LimitPlaced` / `LimitCancelled` / `LimitFilled`, fills reached limits (same stagger), and adds filled positions to its database |
| `node scripts/positions.mjs` | Turns your filled limit orders into position records, so `close.mjs`, `order.mjs` etc. work on them |

`deploy-vault.mjs` also runs `init_limits`. `place_limit` and `cancel_limit` are
relayable. The keeper now handles each event once per scan (the scan windows
overlap; the live run below logged new limit orders twice before this fix).

## 13.6 Testnet (2026-10-16)

Real and demo vaults upgraded (WASM hash
`3fcc5ef07665e514107ec179f6cdafe31120a11870a0344c8a9cf562f879038b`, 76 KB,
71 functions) and `init_limits`. Live run on the demo vault, keepers 1–3
running:

```
price 82,000
placed limit long 3000 / 300 at 80000; order 662745064480…
placed limit short 2000 / 200 at 90000; order 117618240328…
price 79,800
[keeper 1] limit long at 80,000 reached at 79,800
[keeper 1] filled limit long 3,000 at 79,800 -> position #17
[keeper 1|2|3] new position #17 (filled limit): long 3,000 @ 79,800
cancelled limit order 117618240328…; refund note 200 at leaf 18
#17 private LONG  size 3,000 @ 79,800  open
closing #17 long 3,000 @ 79,800 -> 79,800: profit 0, fees 6.0036667 (borrow 0.0036667), payout 293.9963333
```

The long filled at the mark (79,800), not the limit. All three keepers rebuilt
position #17 from the order and the fill. The owner cancelled the short and
then closed the filled position like any other.

## 13.7 Privacy

| | Visible? |
|---|---|
| Placing / cancelling: side, size, collateral, limit | No (order commitment + nullifier) |
| A fill: that an order was filled, entry (mark) price, leaf, keeper | Yes |
| Which note funded it, who owns it | No |
| To keepers | Everything (trust assumption, as for positions) |
