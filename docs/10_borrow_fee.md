# 10. Borrow fee

Positions now pay a **borrow fee** for the time they're open, as on Midnight:

```
borrowFee = ceil(size × borrow_rate × (close time − open time) / 10^12)
```

`borrow_rate` is per second, scaled by 10^12. Midnight's demo value **27,778**
means 0.01% of size per hour (≈ 0.24% per day). That's the default here too
(`BORROW_RATE` in `.env`).

## 10.1 Rules

- It is charged when the position ends: at **close** (step 7) and at
  **liquidation** (step 8). The open time is already in every position
  commitment, so positions opened before this step accrue from their open time.
- It comes out of the equity **together with the closing fee**:
  `fees taken = min(closeFee + borrowFee, collateral − loss)`. Anything that
  doesn't fit (the shortfall) is taken from a profit, exactly as the closing
  fee was.
- It goes to the **treasury's fee note** (step 7), not the pool. A public
  borrow fee would reveal the size (it's proportional to size).
- For liquidation it counts **before** equity is compared with the
  maintenance margin, so a position held long enough can become liquidatable
  from fees alone.

Value is still conserved: `collateral + openFee = payout + fees + pool_in − pool_out`.

## 10.2 Changes

**Circuits** (`close_position.circom`, `liquidate_position.circom`, re-setup
at 2^15). New public input `borrowRate` (32 bits, last in the list); new
private input `borrowFee`. They prove
`borrowFee × 10^12 ≥ size × rate × held > borrowFee × 10^12 − 10^12`,
i.e. exact ceiling. Comparisons are 170 bits wide, since the product is under
2^160.

**Contract** (`close.rs`, `liquidate.rs`):

| Function | Auth | Description |
|---|---|---|
| `set_borrow_rate(rate)` | admin | Applies to every position from then on (positions are settled at the rate in force when they end) |
| `borrow_rate()` | — | View, default 0 |

- `close_position` and `liquidate` pass the stored rate as the proof's last
  public input, so a proof made at another rate fails (test
  `borrow_rate_is_bound_by_the_proof`).
- Events `PositionClosed` and `PositionLiquidated` gain `time` and
  `borrow_rate`. The treasury needs both to recompute a fee note's amount
  (step 9).
- `CLOSE_PUBLIC_INPUTS` and `LIQUIDATE_PUBLIC_INPUTS` are now 12.

**Scripts:** `close.mjs` prints the borrow fee; `positions.mjs` shows the
borrow fee accrued so far; the keeper includes it when checking maintenance;
the treasury uses each event's time and rate; `deploy-vault.mjs` sets
`BORROW_RATE`.

## 10.3 Tests

- **JS:** close after one day at 27,778: borrow fee 12.0000960 on 5,000;
  conservation holds; a forged `borrowRate` public input fails verification.
  For liquidation: a 10× long at −7% is healthy (equity 112 > 100) without the
  borrow fee, and after 2 days (+19.2) it's liquidatable, and the proof
  verifies.
- **Rust:** close and liquidation fixtures regenerated with rate 27,778
  (`close.json`: borrow fee 0.0655561 for 590 s on 4,000).
  `borrow_rate_is_bound_by_the_proof`; `set_borrow_rate` is admin only. 57
  vault tests pass.

## 10.4 Testnet (2026-10-16)

Real vault `CAFE37QA…LIWE` and demo vault `CDNKP3FF…33F2` upgraded (WASM hash
`40d585b0f592b4c7b88d58a28069f2c570eec91fe92b172bb8eaf44106874d1d`), then:
- `set_close_config` and `set_liquidation_config` with the new keys;
- `set_borrow_rate(27778)`;
- on the demo vault, also `init_treasury`.

```sh
set -a; . ./.env; set +a
export STELLAR_ACCOUNT="$ADMIN_SECRET"
stellar contract invoke --id $VAULT_ID --network testnet -- set_close_config \
  --close_vk "$(cd circuits && node scripts/vk-arg.mjs close_position)" --treasury_owner $TREASURY_OWNER_HASH
stellar contract invoke --id $VAULT_ID --network testnet -- set_liquidation_config \
  --liquidate_vk "$(cd circuits && node scripts/vk-arg.mjs liquidate_position)" \
  --config "{\"keepers\":[\"$KEEPER_1_ADDRESS\",\"$KEEPER_2_ADDRESS\",\"$KEEPER_3_ADDRESS\"],\"maintenance_bps\":250,\"liquidation_fee_bps\":50}"
stellar contract invoke --id $VAULT_ID --network testnet -- set_borrow_rate --rate 27778
```

The real vault's price was 71 minutes old, so stale, and opens were refused.
The relayers brought in Chainlink round `…497` (81,409.28). Then a private
long 1,000 / 100 was opened and closed about 33 s later:
```
closing #15 long 1,000 @ 81,409.2785654 -> 81,409.2785654: profit 0, fees 2.0009167 (borrow 0.0009167), payout 97.9990833
```
1,000 × 27,778·10⁻¹² × 33 s = 0.0009167 ✓. The treasury scan then recognized
the fee note (leaf 18, 2.0009167), recomputed with the event's time and rate.
