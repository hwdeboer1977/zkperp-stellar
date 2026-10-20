# 3. Create the LP vault

The vault is ZKPerp's **GMX-style liquidity pool**. LPs deposit mUSDC (step 2)
and receive **zLP shares**. The pool is the counterparty to every trade: it
pays out trader profits and keeps trader losses. The vault is also the **one
contract that holds ZKPerp's tokens**. Trader collateral will live here too
once trading exists, so that moving value between traders and the pool is
internal bookkeeping, not a visible token transfer (ARCHITECTURE §2, §8).

Contract: `contracts/zkperp-vault`. This step builds the LP side only. There
are no positions yet, so `live_positions` is always 0.

## 3.1 Design (mirrors `addLiquidity` / `removeLiquidity` in zkperp-midnight)

| Rule | How |
|---|---|
| First deposit | 1 share per token unit |
| Later deposits | `shares = floor(amount × total_shares / pool_value)` |
| Withdrawals | `amount = floor(shares × pool_value / total_shares)` |
| Rounding | Always down, in the pool's favour |
| Solvency | Every position's profit is capped at one public constant `max_payout`, and every open position reserves exactly that much. `reserved = live_positions × max_payout`. **Invariant: `pool_value > reserved`.** A withdrawal that would break it is refused (`LiquidityReserved`). |
| Idle pool | With no open positions, the last LP may empty the pool completely |
| Pool value | Tracked inside the contract, **not** read from the token balance. Tokens sent to the vault directly don't change the share price, which blocks the first-depositor "inflation" attack. |
| zLP | Share balances inside the vault (`shares_of`), not a separate token. Not transferable. |

**Why reserve `max_payout` per position** (the Midnight design): GMX reserves
each position's size, which would publish every size. Reserving one constant
per position keeps every possible profit payable while revealing only the
number of open positions, which is visible anyway. The cost is capital
efficiency: the pool must hold `max_payout` for every open position.

**Public vs private.** LP deposits and withdrawals are ordinary public token
transfers, the same as on Midnight, so `pool_value` and `total_shares` are
public. ARCHITECTURE §8 plans to move trader PnL and fees into hidden
accumulators. When that lands, LP deposits and withdrawals become two-step,
settling at the share price revealed each epoch. The vault's interface was
chosen so that change doesn't affect LPs' calls.

## 3.2 Contract interface

| Function | Auth | Description |
|---|---|---|
| `__constructor(admin, token, max_payout)` | — | `token` = collateral SAC (`COLLATERAL_SAC`); `max_payout` in token units (> 0) |
| `deposit(lp, amount) → shares` | `lp` | Pulls `amount` from `lp`, mints shares. Emits `Deposit { lp, amount, shares }`. |
| `withdraw(lp, shares) → amount` | `lp` | Burns shares, pays `lp`. Emits `Withdraw { lp, shares, amount }`. |
| `preview_deposit(amount)` / `preview_withdraw(shares)` | — | Same maths without moving anything |
| `withdrawable()` | — | What LPs can take out now: everything if idle, else `pool_value − reserved − 1` |
| `reserved()`, `live_positions()`, `max_payout()` | — | Solvency figures |
| `pool_value()`, `total_shares()`, `shares_of(lp)` | — | Pool state |
| `token()`, `admin()` | — | Configuration |
| `upgrade(new_wasm_hash)` | `admin` | Replaces the code and keeps the address, balances and storage. This is how the trading logic gets added during the hackathon. |

Errors: `InvalidAmount` (1), `DepositTooSmall` (2), `InsufficientShares` (3),
`WithdrawalTooSmall` (4), `LiquidityReserved` (5), `Overflow` (6),
`InvalidConfig` (7), `PoolEmpty` (8, shares exist but the pool is worth 0).

Storage: configuration and totals in instance storage; one persistent entry
per LP for shares. Both have their TTL extended (to about 31 days) whenever
they're touched, so balances don't get archived.

## 3.3 Tests

`cargo test -p zkperp-vault`, 9 tests:

- First deposit mints 1:1; tokens move from the LP to the vault.
- Deposits need the LP's authorization and emit `Deposit`.
- Later deposits are pro rata and round down.
- Withdrawals are pro rata and round down (the remainder stays in the pool).
- The last LP can empty an idle pool.
- **Reserved liquidity can't leave:** with 3 live positions and 20,000 in the
  pool, 15,000 is reserved, exactly 4,999.9999999 can be withdrawn, and one
  more unit is refused.
- **Inflation attack blocked:** an attacker deposits 1 unit and donates
  1,000,000 directly; the next depositor still gets 1 share per unit.
- Bad amounts, over-withdrawal, unknown LPs and `max_payout = 0` are rejected.

Tests that need open positions set `live_positions` directly in storage, as a
stand-in for the perp logic that doesn't exist yet.

## 3.4 Testnet deployment (2026-10-16)

| | Value |
|---|---|
| Vault contract | `CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE` |
| Admin | `GAESCDLAKL5BYVBQN27RWQY6AEKZBOWAIQ2T5CDLLHKX2SILU72TVVQB` (`ADMIN_*` in `.env`, step 1) |
| Token | mUSDC SAC `CBHTUBAWUPTL7PYMO556GAFS7PIFVF3VQZYNPXOQDSP6MHX4HD24NOMM` |
| `max_payout` | `50000000000` = 5,000 mUSDC (same as `maxPayout` in zkperp-midnight) |
| WASM size | 10.7 KB |
| Deployed by | the mUSDC issuer account (only paid the fee; it has no role in the vault) |

Checks run on testnet with the test trader account (`TRADER_*`):

| Check | Result |
|---|---|
| `deposit` 40 mUSDC | 400000000 shares (1:1) ✓ |
| `withdraw` 10 shares | 100000000 units = 10 mUSDC ✓ |
| `shares_of` / `pool_value` / `total_shares` | 30 / 30 / 30 mUSDC ✓ |
| Vault's real mUSDC balance | 30 mUSDC, equal to `pool_value` ✓ |
| `reserved` / `withdrawable` | 0 / 30 mUSDC (no positions) ✓ |
| Withdraw more shares than held | `Error(Contract, #3)` InsufficientShares ✓ |

The test account still holds 30 shares (30 mUSDC) in the vault. On
2026-10-16 the vault was upgraded to steps 4 + 5 (same address, balances and
shares kept); see `docs/5_price_oracle.md` §5.7.

## 3.5 Deploy (reproducible)

```sh
set -a; . ./.env; set +a      # from the repo root (step 1, §1.1)
stellar contract build --package zkperp-vault
VAULT=$(stellar contract deploy --wasm target/wasm32v1-none/release/zkperp_vault.wasm \
  --source "$ADMIN_SECRET" --network testnet \
  -- --admin $ADMIN_ADDRESS --token $COLLATERAL_SAC --max_payout 50000000000)
```

Then set `VAULT_ID` in `.env`.

## 3.6 Using the vault as an LP

An LP needs mUSDC first (step 2, §2.5: trustline + faucet `mint`). Example for
LP 1 (`LP_1_SECRET` filled in `.env`):

```sh
set -a; . ./.env; set +a      # from the repo root (step 1, §1.1)

# Deposit 10,000 mUSDC
stellar contract invoke --id $VAULT_ID --source "$LP_1_SECRET" --network testnet \
  -- deposit --lp $LP_1_ADDRESS --amount 100000000000

# Check position and pool
stellar contract invoke --id $VAULT_ID --source "$LP_1_SECRET" --network testnet --send=no -- shares_of --lp $LP_1_ADDRESS
stellar contract invoke --id $VAULT_ID --source "$LP_1_SECRET" --network testnet --send=no -- pool_value

# Withdraw 1,000 shares
stellar contract invoke --id $VAULT_ID --source "$LP_1_SECRET" --network testnet \
  -- withdraw --lp $LP_1_ADDRESS --shares 10000000000
```

`deposit` moves the LP's tokens with a token-transfer authorization that the
CLI signs automatically, because the LP is also the transaction source.

## 3.7 Next

- Trader side: shielded collateral deposits into the same vault (notes,
  Merkle tree, nullifiers), then positions.
- When positions exist, the perp logic updates `live_positions` and settles
  PnL against `pool_value`, added through `upgrade`.
