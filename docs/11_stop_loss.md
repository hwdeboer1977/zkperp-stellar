# 11. Stop loss

A trader attaches a **stop loss** to their position: once the mark price
crosses the stop level against them, a **keeper closes the position** for them.
The public doesn't see which position has an order, whether it's a stop loss
or a take profit, or the level.

Stop loss and take profit (step 12) are one mechanism, a **trigger order**:
Midnight's `placeOrder` / `cancelOrder` / `executeOrder`. This doc describes
it; step 12 covers what's specific to take profit.

## 11.1 How it works

```
owner (relayed, no signature)          keepers (registered, sign)
──────────────────────────────         ──────────────────────────
place_order: proof of ownership  ──▶   decrypt order note: [leaf, kind, level, orderSalt]
  + order id + order note              watch mark price
                                       crossed? → execute_order: close at the mark price
cancel_order: same proof, action 2      payout note → owner (salt Poseidon(salt, 3))
```

- **Order id** = `Poseidon(position salt, kind, trigger, orderSalt)`. It's the
  only thing the public sees when an order is placed.
- **Order note:** `[leafIndex, kind, trigger, orderSalt]`, verifiably
  encrypted to the keepers' view key, with the same scheme as the keeper note
  at open (shared template `seal.circom`). Keepers learn which position it
  belongs to and the level.
- **Firing rule** (`below = isLong XOR kind`):

| | Long | Short |
|---|---|---|
| **Stop loss** (kind 0) | fires at mark ≤ stop | fires at mark ≥ stop |
| **Take profit** (kind 1) | fires at mark ≥ target | fires at mark ≤ target |

- **Execution is a close** at the **mark price** (not at the level, as on
  Midnight). It uses the step-7/10 settlement: PnL against the pool (profit
  capped at `max_payout`), closing and borrow fees to the treasury note. The
  payout goes to the owner hash with salt `Poseidon(salt, 3)`, so the owner
  can find it.
- **Who can do what:**
  - only the owner can place or cancel an order (ownership proof);
  - only a registered keeper can execute, only once the level is crossed (the
    proof checks it against the signed mark price), and only once (the order
    id is removed and the position's nullifier spent);
  - `action` is a public input, so a placement proof can't be replayed as a
    cancellation.
- If the position is closed or liquidated first, the order can never execute
  (the position's nullifier is spent).

## 11.2 Circuits

| Circuit | Constraints | Public | Outputs |
|---|---|---|---|
| `order_auth.circom` (place / cancel) | ~13,400 non-linear | `root`, `action` (1/2), `keeperPk` | `orderId`, `noteR`, `note[4]` |
| `execute_order.circom` | ~9,800 non-linear | close's 7 (`root`, `exitPrice`, `closeTime`, `feeBps`, `maxPayout`, `treasuryOwner`, `borrowRate`) + `orderId` | `nullifier`, `payoutCommitment`, `feeCommitment`, `poolIn`, `poolOut` |

`execute_order` is `close_position` with:
- the owner **hash** (keepers have no owner secret);
- the order-id check and the firing rule;
- the derived payout salt.

Both use 2^15 single-party setups. While building this I briefly turned the
firing rule into XNOR; the four-way JS test (below) is there to catch exactly
that.

## 11.3 Contract (`contracts/zkperp-vault/src/orders.rs`)

| Function | Auth | Description |
|---|---|---|
| `init_orders(order_auth_vk, execute_order_vk)` | admin, once | |
| `set_order_vks(…)` | admin | |
| `place_order(root, order_id, note_r, note, proof)` | none | Registers the id. Event `OrderPlaced { order_id, note_r, note }`. Errors: `OrderExists` (37). |
| `cancel_order(root, order_id, note_r, note, proof)` | none | Removes it. Event `OrderCancelled`. Errors: `NoSuchOrder` (36). |
| `execute_order(keeper, order_id, root, nullifier, payout, fee, pool_in, pool_out, close_time, proof) → payout leaf` | keeper | The order must be open; then the same checks and settlement as `close_position`, which are now a shared function (`settle_position`). Stores an `ExecutionRecord` for the owner. Event `OrderExecuted`. |
| `is_order_open(order_id)`, `order_execution(nullifier)` | — | Views |

## 11.4 Tests

**JS** (`test/orders.test.mjs`):
- the firing rule for all 4 combinations, crossed and not crossed;
- place and cancel proofs verify, and keepers decrypt the order note;
- a place proof re-labelled as a cancel fails;
- a stranger can't place an order;
- the keeper's execute proof verifies for every order type once crossed, and
  can't be made before; the owner can recompute the payout note.

**Rust** (`test_orders.rs`, real proofs from `scripts/orders-fixture.mjs`): a
private long with a stop loss at 79,000 and a take profit at 90,000:
- placing needs no signature;
- the take profit is cancelled;
- the price falls to 78,500 and the keeper executes the stop loss: loss to the
  pool, reservation freed, execution record kept;
- a duplicate placement → `OrderExists`;
- cancelling an unknown order or executing twice → `NoSuchOrder`;
- before the crossing → `InvalidProof`; a non-keeper → `NotAKeeper`.

61 vault tests and 18 JS tests pass.

## 11.5 Scripts

| Command | Does |
|---|---|
| `node scripts/order.mjs place <leaf> sl <price> [ROLE]` | Places a stop loss (proof + relay); keeps the order record in `.zkperp/orders/` |
| `node scripts/order.mjs cancel <order id prefix> [ROLE]` | Cancels it |
| `node scripts/order.mjs list` | Your orders, open or done |
| `node scripts/keeper.mjs --keeper n` | Now also syncs `OrderPlaced`/`OrderCancelled`, and executes crossed orders before checking liquidations (same stagger) |
| `node scripts/positions.mjs` | Shows **closed by ORDER**, and saves the payout note |

`deploy-vault.mjs` also runs `init_orders`. `place_order` and `cancel_order`
are relayable.

## 11.6 Testnet (2026-10-16)

Real vault and demo vault upgraded (WASM hash
`c906228eecdc762658aed355c8b538ca0e574a680fa5e94fd07659fcf5a122be`, 70 KB,
64 functions) and `init_orders`. Live run on the **demo vault** (test prices),
with keepers 1–3 running:

```
price 82,000
opened private position #6 (long 4,000 / 400)
placed stop loss at 80000 on #6
placed take profit at 95000 on #6     -> cancelled
price 79,500
[keeper 1] stop loss on #6 crossed at 79,500
[keeper 1] executed stop loss on #6: loss 121.95, owner gets 270.03 (note leaf 10)
[keeper 2] #6 is closed          [keeper 3] #6 is closed
#6 private LONG  size 4,000 @ 82,000  closed by ORDER at 79,500, payout 270.03
```

Check: loss = 4,000 × 2,500 / 82,000 = 121.95; payout = 396 − 121.95 − 4
(closing fee) − borrow fee ≈ 270.03. The cancelled take profit never fired.

## 11.7 Privacy

| | Visible? |
|---|---|
| That *an* order was placed / cancelled | Yes (order id) |
| Which position, kind (SL/TP), level | No |
| At execution: exit price, PnL (pool's change), which keeper | Yes (as a close / liquidation) |
| Payout, fees | No (notes) |
| To keepers | Everything about the order, as for positions |
