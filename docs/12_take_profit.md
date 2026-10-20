# 12. Take profit

A **take profit** closes a position once the mark price reaches the trader's
target in their favour: a long at or above the target, a short at or below it.
It's the same trigger-order mechanism as the stop loss (step 11): the same
circuits, contract functions, keeper service and privacy. Only the order
**kind** (1 instead of 0) and the direction of the firing rule differ.

## 12.1 What's specific

| | Stop loss (kind 0) | Take profit (kind 1) |
|---|---|---|
| Long fires at | mark ≤ stop | mark ≥ target |
| Short fires at | mark ≥ stop | mark ≤ target |
| Usual outcome | loss to the pool | profit from the pool |

- **Profit cap still applies.** The pool pays at most `max_payout` (step 3). A
  take profit above the level where the cap binds pays the cap, exactly as a
  manual close would.
- **Executed at the mark price, not the target.** If the price jumps past the
  target between oracle updates, the trader gets the (better) mark price, as
  on Midnight.
- **Stop loss and take profit can sit on the same position.** Whichever
  crosses first closes it; the other can then never execute, because the
  position's nullifier is spent.

## 12.2 Usage

```sh
cd circuits
node scripts/order.mjs place <position leaf> tp <target price> [ROLE]
node scripts/order.mjs list
node scripts/order.mjs cancel <order id prefix>
```
Keepers (`node scripts/keeper.mjs --keeper 1..3`) execute it; the owner's
`node scripts/positions.mjs` shows it as **closed by ORDER** and saves the
payout note.

## 12.3 Tests

Covered by step 11's tests: the JS firing-rule test checks long TP at ≥ and
short TP at ≤, and the keeper execute proof is made and verified for a long TP
(crossed at 84,000) and a short TP (crossed at 75,000), and refused before
crossing. The Rust fixture places a take profit and cancels it.

## 12.4 Testnet (2026-10-16, demo vault)

In the same live run as step 11:
```
price 82,000
opened private position #8 (long 2,000 / 200)
placed take profit at 84000 on #8
price 84,500
[keeper 1] take profit on #8 crossed at 84,500
>> take profit executed (order no longer open)
#8 private LONG  size 2,000 @ 82,000  closed by ORDER at 84,500, payout 256.97
```
Check: profit = 2,000 × 2,500 / 82,000 = 60.98, paid from the pool; payout =
198 − 2 (closing fee) − borrow fee + 60.98 ≈ 256.97. Keepers 2 and 3 saw the
same crossing and stood by.

(Keeper 1's own "executed" log line for this order is missing from the
capture: the keepers were stopped as soon as the chain showed the order done,
before the line was flushed. The execution is confirmed on chain: the order is
no longer open, and the owner's payout note was recovered.)
