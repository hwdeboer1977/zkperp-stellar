# 5. Price oracle (2-of-3 signed Chainlink)

The vault's mark price, which every open (step 4) and later every close and
liquidation is priced against, comes from **Chainlink BTC/USD**, relayed by
**three oracle signers**. A price update needs signatures from two of them.
This is the same design as zkperp-midnight (`setPrice`, `signedByTwo`,
`rotateSigner` and `services/oracle/relayer.ts`), ported to Soroban.

It replaces step 4's temporary mock price, which a single key could set to
anything.

## 5.1 Design

```
Chainlink BTC/USD aggregator (Ethereum mainnet)
          │ latestRoundData(): roundId, answer (8 dec), updatedAt
          ▼
  relayer 1      relayer 2      relayer 3        each signs the same report
  (oracle-1)     (oracle-2)     (oracle-3)       and serves its signature
      │◀── GET /signature/<round> ──▶│
      ▼
  set_price(round, price, updated_at, first, second, sig_a, sig_b)  ──▶ vault
```

| Rule (contract) | Why |
|---|---|
| Two valid **ed25519** signatures, from slots `first < second < 3` | No single signer can set the price |
| Message = `sha256(xdr(("zkp_price", vault, round, price, updated_at)))` | The vault's address makes a report valid on this vault only (and this network) |
| `round > current round` | Rounds only move forward: an old report can't be replayed |
| `updated_at ≤ ledger time` and `≥ current price time` | No prices from the future; time never goes back |
| `0 < price < 2^63` | Range the open circuit accepts |
| **Anyone may submit** | The signatures are the authority, not the submitter's account |
| Opens refuse a price older than `max_price_age`, measured from `updated_at` | The age counts from when the price was **observed**, not when it was submitted |

`max_price_age` should sit just above the feed's heartbeat. Chainlink BTC/USD
on Ethereum updates on a 0.5% move or every hour, so the hackathon uses
**3,900 s** (65 minutes).

**Why ed25519 instead of Midnight's Schnorr-on-Jubjub:** Soroban verifies
ed25519 natively and cheaply, and every Stellar account key is an ed25519 key,
so a signer is just a Stellar account (`ORACLE_1..3_*` in `.env`). It signs with
its account key and pays submission fees from the same account.

**Price units:** Chainlink's 8-decimal answer is divided by 10 (rounded down)
into the vault's 7 decimals, the same as mUSDC.

## 5.2 Contract (`contracts/zkperp-vault/src/oracle.rs`)

| Function | Auth | Description |
|---|---|---|
| `set_price(round, price, updated_at, first, second, sig_a, sig_b)` | none (signatures) | Sets the mark price. Emits `PriceSet { round, price, time, signers }`. |
| `rotate_signer(slot, key, first, second, sig_a, sig_b)` | none (signatures) | Two signers put a new key in a slot (lost or leaked key). Message domain `"zkp_rotat"` + `signer_epoch`, so a rotation can't be replayed or passed off as a price. Keys must stay distinct. Emits `SignerRotated`. |
| `mark_price()` | — | `{ price, time, round, signers }`; `time` is the round's `updated_at` |
| `signer_epoch()` | — | Rotations so far |
| `price_digest(round, price, updated_at)`, `rotation_digest(epoch, slot, key)` | — | The exact bytes to sign, so clients can check their encoding |

`PerpConfig.oracle` (step 4's single mock key) is replaced by
`PerpConfig.signers`: the three 32-byte ed25519 public keys, required to be
distinct at `init_perp`. Step 4's mock `set_price(price)` is gone.

Errors: `InvalidSignerSlots` (19), `StaleRound` (20), `PriceTimeInvalid` (21),
`InvalidPrice` (13). A wrong signature makes the host abort the transaction
(ed25519 verification traps instead of returning an error).

## 5.3 Cost (compiled WASM)

| | Instructions | Share of 400M |
|---|---|---|
| `set_price` (2 × ed25519 + storage + event) | **1.8M** | 0.45% |
| `open_position` (unchanged) | 56.2M | 14% |

## 5.4 Tests

`cargo test -p zkperp-vault`, 8 oracle tests (28 vault tests in total):

| Test | Shows |
|---|---|
| `js_and_contract_sign_the_same_bytes` | Digest built by **stellar-sdk** (`circuits/lib/oracle.mjs`) equals the contract's; signatures made in JS verify on-chain (fixture `src/fixtures/oracle.json`, vault registered at the real vault's address) |
| `rounds_only_move_forward_and_time_is_checked` | Replayed round, older round, older time, future time are refused; newer round at the same time is accepted |
| `needs_two_different_signers_in_order` | Slots (0,0), (1,0), (2,3) refused |
| `signature_by_the_wrong_signer_traps` | Claiming slot 1 with signer 3's signature aborts |
| `signature_over_another_price_traps` | Signed 50, submitted 51: aborts |
| `report_for_another_vault_traps` | A report signed for vault A doesn't verify on vault B |
| `two_signers_rotate_the_third` | Rotation works, epoch increments, and the new key then signs prices |
| `rotation_to_a_duplicate_key_is_refused` | Two slots can't hold the same key |

Step 4's trading tests now set their prices through signed reports too.

## 5.5 Relayer (`circuits/scripts/relayer.mjs`)

```sh
cd circuits
node scripts/relayer.mjs --signer 1     # terminal 1
node scripts/relayer.mjs --signer 2     # terminal 2
node scripts/relayer.mjs --signer 3     # terminal 3
```

- Polls Chainlink every 15 s (`RELAYER_POLL_MS`) and acts only on a **new
  round**. Pricing is strict: an open proven at one price fails if the price
  changes first, so re-stamping an unchanged price would keep failing traders'
  opens.
- Signs each new round with its own key and serves the signature on
  `http://127.0.0.1:<3019+n>/signature/<round>`. `/health` shows the last
  round, the vault's round and submissions.
- **Staggered submission:** signer *n* waits (n − 1) × 20 s
  (`RELAYER_STAGGER_MS`). Then, if the round isn't on chain yet, it fetches a
  peer's signature for the same report and submits both. Normally signer 1
  submits; if it's down, signer 2 does after 20 s, and so on. If two submit at
  once, one lands and the other fails with `StaleRound` (and pays its fee).
- Refuses to start if its key isn't the vault's signer in that slot.
- Configuration: `VAULT_ID` (from `.env`), `EVM_RPC_URL` (default
  `https://ethereum-rpc.publicnode.com`, no key needed), `ORACLE_PEERS`
  (default localhost 3020–3022). The signing key is `ORACLE_<n>_SECRET` from
  `.env`, held in memory only.

**Test prices:** `node scripts/price.mjs <price>` signs a price locally with
signers 1 and 2 (round = current + 1), for crash scenarios. Don't run it on a
vault whose relayers are running: its round can be at or above the next
Chainlink round, which would then be refused as stale until Chainlink moves
past it. zkperp-midnight has the same rule for `demo` / `race`.

## 5.6 Signers

| `.env` names | Address | Slot |
|---|---|---|
| `ORACLE_1_ADDRESS`, `ORACLE_1_SECRET` | `GABCY5MFW22QJZ7S5WGIMJEZW4JFVK7WX63DMEG5PJX5H2WKTGCFI725` | 0 |
| `ORACLE_2_ADDRESS`, `ORACLE_2_SECRET` | `GAXXVOPZI7VWN3RARMS65LUL7GMJFTOHICJJPC6HA5DPPG3DN5WJMJNL` | 1 |
| `ORACLE_3_ADDRESS`, `ORACLE_3_SECRET` | `GC5D6ZNULQS6JRS3XTDTL3WH25F7NHNRFNEQX7TUB5GYUELZHZMO2K5P` | 2 |

Funded by Friendbot. Their raw ed25519 keys (what `init_perp` takes) come
from `lib/oracle.mjs` `rawKey(address)`. Step 4's single mock key is no longer
used.

> As on Midnight: the contract proves that two of three **keys** signed, not
> that independent parties hold them. For the hackathon one operator runs all
> three. Production gives each signer to a separate operator.

## 5.7 Testnet (2026-10-16)

### Dry run: dry-run vault v2

The step-4 dry-run vault stored the old config format, so a new one was
deployed with the step-5 code (test account as admin):

| | Value |
|---|---|
| Dry-run vault v2 | `CCWX2ATXVSGSORYNJCIPSIEYK26I4AWMPHYQVI2AB3ATPROJYWYSYTXS` |
| Signers | `ORACLE_1..3` |
| `max_price_age` | 3,900 s |
| Liquidity | 15,000 mUSDC |

All three relayers ran against **live Chainlink** for 75 s:
```
[signer 1] signed round 129127208515966886494: 81921.0717809 (updatedAt 1792156547)
[signer 2] signed round 129127208515966886494: 81921.0717809 (updatedAt 1792156547)
[signer 3] signed round 129127208515966886494: 81921.0717809 (updatedAt 1792156547)
[signer 1] submitted round 129127208515966886494 with signers 1+2
```
`mark_price` → `{"price":"819210717809","round":"129127208515966886494","signers":[0,1],"time":1792156547}`.
Signers 2 and 3 saw the round on chain and didn't resubmit.

Then a long opened **at the live Chainlink price** and was read back by a keeper:
```
#0 LONG  size 3,000  collateral 297  entry 81,921.0717809  fee 3  leverage 10.10x  commitment matches
```
And a test price for a crash scenario: `node scripts/price.mjs 70000` → round
`…495`, price 70,000, signers [0, 1].

**Failover, tested live later the same day** (during step 6, see
`docs/6_shielded_collateral.md` §6.7): with only signers 2 and 3 running,
signer 2 submitted round `…495` (BTC/USD 82,089.01) with signatures 2+3 after
its 20 s turn, and signer 3's later attempt failed with `StaleRound`, as
designed.

### The real vault (done, 2026-10-16)

`CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE` was upgraded from the
step-3 code to steps 4 + 5 in one go, keeping its address, balances and LP
shares:

| Step | Result |
|---|---|
| Before | `pool_value` 30 mUSDC, `total_shares` 30 (step-3 test deposit) |
| `stellar contract upload` (signed by `ADMIN_SECRET`) | WASM hash `3c45f6d7caf9bbee0515d4c8fb043c27c57aebdbbfee726a54a95f00f83f1bb3` (37 KB) |
| `upgrade --new_wasm_hash …` | Same address; `pool_value` still 30, admin unchanged, new functions respond |
| `init_perp` | Signers `ORACLE_1..3`, keeper view key (`KEEPER_VIEW_PK_X/Y`), `fee_bps` 10, `max_price_age` 3,900 s, open-position VK |
| Relayers (3, 45 s) | Round `129127208515966886494`, BTC/USD **81,921.0717809**, signed and submitted by signers 1+2 |
| Liquidity | The test trader (`TRADER_*`) minted and deposited 20,000 mUSDC → `pool_value` 20,030 |
| Opens | `#0` long 5,000 / 500 collateral, `#1` short 2,000 / 400 |

What a keeper reads from the chain (`node scripts/keeper-read.mjs`):
```
#0 LONG  size 5,000  collateral 495  entry 81,921.0717809  fee 5  leverage 10.10x  commitment matches
#1 SHORT size 2,000  collateral 398  entry 81,921.0717809  fee 2  leverage 5.03x  commitment matches
```
Vault afterwards: `live_positions` 2, `reserved` 10,000, `collateral_held` 900,
`pool_value` 20,030, `withdrawable` 10,029.9999999. The vault's mUSDC balance
is 20,930 = `pool_value` + `collateral_held`.

The commands, so they can be repeated after a testnet reset (the original run
signed with a keystore identity; the secrets are now in `.env`):
```sh
set -a; . ./.env; set +a      # from the repo root (step 1, §1.1)
stellar contract build --package zkperp-vault
HASH=$(stellar contract upload --wasm target/wasm32v1-none/release/zkperp_vault.wasm \
  --source "$ADMIN_SECRET" --network testnet)
stellar contract invoke --id $VAULT_ID --source "$ADMIN_SECRET" --network testnet \
  -- upgrade --new_wasm_hash $HASH

SIGNERS=$(cd circuits && node -e 'import("./lib/oracle.mjs").then(o => console.log(JSON.stringify([1,2,3].map(n => o.rawKey(process.env["ORACLE_"+n+"_ADDRESS"])))))')
stellar contract invoke --id $VAULT_ID --source "$ADMIN_SECRET" --network testnet -- init_perp \
  --config "{\"signers\":$SIGNERS,\"keeper_key\":{\"x\":\"$KEEPER_VIEW_PK_X\",\"y\":\"$KEEPER_VIEW_PK_Y\"},\"fee_bps\":$FEE_BPS,\"max_price_age\":$MAX_PRICE_AGE}" \
  --open_vk "$(cd circuits && node scripts/vk-arg.mjs open_position)"
```

**Keep the relayers running** while the vault is used. A price older than 65
minutes stops opens. Run each in its own terminal:
```sh
cd circuits && node scripts/relayer.mjs --signer 1    # and --signer 2, --signer 3
```

## 5.8 What this oracle does and doesn't protect against

| Risk | Status |
|---|---|
| One signer key leaks | Can't set a price alone. The other two rotate it out (`rotate_signer`). |
| Replaying an old report | Refused: rounds only move forward |
| A report for another vault or network | Refused: the vault address is in the signed message |
| Oracle stops (relayers down) | Prices go stale after 65 min and **opens stop**, as on Midnight. Trading at a stale price would let traders choose their price. |
| Oracle lags the market | Chainlink moves only on 0.5% / hourly, so a trader watching exchanges can trade on up to ~0.5% of known movement. Opening and closing fees absorb most of it; a faster feed (Chainlink Data Streams, Pyth) or a spread around the price would close it (ARCHITECTURE §4). |
| Two of three signers collude or are one operator | They can set any price. Mitigation is organisational: separate operators. |
| Ethereum RPC returns a wrong value | Each signer reads its own RPC; with separate operators and RPCs, one bad source can't move the price. Today all three use the same public endpoint. |

## 5.9 Next

- Keep the relayers running (§5.7) and test failover across a new round.
- Close a position at the mark price, then liquidation by keepers.
- Later: Chainlink on Stellar itself (Data Streams went live on Stellar mainnet
  on 14 Oct 2026; ARCHITECTURE §4) instead of relaying from Ethereum.
