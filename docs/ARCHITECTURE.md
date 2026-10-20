# ZKPerp on Soroban: Architecture

Status: design draft. Built so far: the Groth16 verifier
(`contracts/zk-verifier`) and the circomlib-compatible Poseidon check
(`crates/zkperp-poseidon`, §5.1), the LP vault (step 3), private opens
(step 4), the 2-of-3 Chainlink oracle (step 5) and shielded collateral notes
with a relayer (step 6) closing positions (step 7), liquidation by
keepers (step 8), treasury fee collection (9), borrow fee (10), stop loss and
take profit (11-12), limit orders (13), keeper / oracle backend servers
(14-15), the frontend (16), records on chain (17), and relayer documentation (18).

## 1. Goals and trust model

ZKPerp is a perpetual futures exchange on Stellar Soroban where positions are
private. **Maximum privacy** is the goal. On-chain, an observer must not learn
who holds a position, its size, direction, collateral, entry price, leverage,
liquidation price, fees paid or realised PnL. Liquidity comes from a
**GMX-style pool** (§8).

To get there we use **three designated keepers that we trust**. Three keepers
reduce liveness risk: any one of them can do any keeper job. Keepers are
trusted only for **data and liveness**. The ZK circuits and contract checks
make sure they cannot take funds or force incorrect results.

| A keeper CAN | A keeper CANNOT |
|---|---|
| See every position (shared keeper view key) | Close or take over a trader's position (needs `owner_sk`) |
| Execute orders at the oracle price | Execute at a price that wasn't signed by the oracle, or that is older than the order |
| Liquidate a position that is underwater at the oracle price | Liquidate a healthy position (the circuit's health check fails) |
| Insert queued commitments into the tree | Insert anything that isn't in the on-chain queue, or skip or reorder queued entries |
| Delay or censor orders, insertions, reveals | Send value anywhere the circuit doesn't allow |
| Trade using what it knows about positions (policy risk) | Misreport pool totals (the contract checks the opening, §8) |

Risks we accept: if the view key leaks, positions are exposed; keepers could
front-run because they see everything. Keepers gate execution, liquidation,
tree insertion and epoch reveals. If **all three** are down, escape hatches
take over (§10).

## 2. Components

```
                 ┌──────────────────────── Soroban ────────────────────────┐
 SEP-41 token ◀─▶│ Perp contract (single token balance for everything)    │
                 │  • Merkle tree of commitments + recent-root history    │
                 │  • pending queue of new commitments (on-chain)         │
                 │  • nullifier set (persistent storage)                  │
                 │  • keeper registry: 3 addresses + current view key     │
                 │  • hidden accumulators: OI, pool assets, PnL, fees     │
                 │  • revealed per-epoch totals, funding/borrow indices   │
                 │  • calls ──▶ Groth16 verifier (VK per circuit, MSM)    │
                 │  • calls ──▶ Oracle verifier (signed price reports)    │
                 └──────────────────────────▲──────────────────────────────┘
                                            │ txs / events
          ┌─────────────────────────────────┴──────────────────────┐
          │ Keepers ×3 (trusted, off-chain, independent operators) │
          │  • persistent indexer (events outlive the RPC window)  │
          │  • decrypt with shared view key → private position DB  │
          │  • execute orders, liquidate, insert batches, reveal   │
          │  • pull signed prices from the oracle network          │
          └─────────────────────────────────▲──────────────────────┘
                                            │ order proofs + ciphertexts
                               Traders / agents (client SDK, local proving)
```

The contract's real SEP-41 balance changes **only** on deposits and
withdrawals. Moving value between trader collateral, the LP pool, fees and
keepers is internal bookkeeping, kept in hidden accumulators (§8).

## 3. Keepers (×3)

- **Decryption:** all three share one **keeper view key** (BabyJubJub). Traders
  encrypt to the current view key, whose public half is stored in the contract.
  Threshold decryption (2-of-3) was rejected: it would need two keepers online
  to see a position at all, which brings back the liveness risk. Since every
  keeper sees everything either way, separate keys would add no privacy.
- **Authority:** keeper actions take a `keeper: Address` argument. The contract
  calls `keeper.require_auth()` and checks the address is one of the 3
  registered keepers. Authority comes from Soroban's built-in auth, not from a
  key inside the circuit, so each keeper can be revoked on its own and every
  action is attributable to a keeper. A leaked `position_secret` alone can't be
  used to liquidate.
- **Coordination:**
  - Orders and liquidations: keeper `k` is the primary when
    `leaf_index mod 3 == k` (queue index for pending orders). The other two
    step in after a grace period, for example 2 ledgers. Duplicate attempts are
    harmless because nullifiers let only one succeed.
  - Tree insertion and epoch reveals: one designated keeper per epoch,
    rotating, so the three don't race each other on the same state.
- **Rotation:** governance (timelocked) can replace a keeper address or the
  view key. Positions opened under an old view key stay readable because
  keepers keep the old private keys. Authority doesn't depend on the view key,
  so rotating it never strands a position.
- **Compensation:** keepers are paid from the epoch fee total revealed in §8,
  never per trade, because a per-trade fee would reveal the trade's size.
  Trusted keepers don't need an incentive that scales with position size.

## 4. Oracle

A perp needs low-latency prices, and it must not be possible to pick a
favourable price after the fact. That points to a **pull oracle**: signed price
reports fetched off-chain, submitted inside the transaction and verified
on-chain. GMX v2 works this way.

| Provider | Model | Fit for ZKPerp |
|---|---|---|
| **Chainlink Data Streams** | Pull, low latency, built for derivatives | **Primary candidate.** Same design as GMX v2. Reported live on Stellar mainnet 14 Oct 2026; SDF covers oracle costs through Chainlink Scale. Testnet availability still to confirm. |
| **Pyth Pro (Lazer)** | Pull, real-time, verifier contract on Stellar | **Alternative primary.** Mainnet + testnet, `pyth-lazer-stellar-sdk`. Needs a subscription. |
| RedStone | Push (deviation 0.01–0.5%, heartbeat 12–24 h), SEP-40 | Sanity check / circuit breaker only |
| Reflector | SEP-40; Pulse feed updates every 5 min (free), Beam is faster (paid) | Sanity check / circuit breaker only |

Contract rules for every price used:
1. Verify the report's signature and feed ID.
2. `report_timestamp` must be **after** the order's creation, and within a
   staleness bound.
3. Optional circuit breaker: reject the price if it deviates more than X% from
   a push feed.
4. Pass the verified price into the Groth16 public inputs. Proofs never bring
   their own price.

**Built for the hackathon (step 5, `docs/5_price_oracle.md`):** a push
oracle in the zkperp-midnight style instead: Chainlink BTC/USD read from
Ethereum by three relayers, each signing with an ed25519 (Stellar) key, and a
price update needs 2 of 3 signatures. Opens are single-step against that
price. The pull oracle with two-step execution above remains the target for
lower latency.

**Testnet:** the 20-agent experiment uses a **mock pull oracle** that we sign
ourselves, so we can script crashes. The real provider plugs in behind the same
interface.

## 5. Data model

All hashes are Poseidon over the BN254 scalar field (circomlib parameters, see
§5.1). In-circuit encryption and the accumulators use BabyJubJub, whose base
field is BN254's scalar field.

```
note_commitment     = Poseidon(asset, amount, owner_pk, note_secret)
note_nullifier      = Poseidon(note_secret, leaf_index)

order_commitment    = Poseidon(type, side, size_delta, collateral_delta,
                               acceptable_price, owner_pk, order_secret)
order_nullifier     = Poseidon(order_secret, queue_index)

position_secret     = Poseidon(order_secret, TAG_POS)      // trader can recompute
position_commitment = Poseidon(size, side, collateral, entry_price,
                               funding_idx, borrow_idx, owner_pk, position_secret)
position_nullifier  = Poseidon(position_secret, leaf_index)
```

- `position_secret` is **derived from the order**, so the trader can
  recompute it, and it is new for every order because each order has a fresh
  `order_secret`. Keepers already know `order_secret` (they need it to nullify
  the order), so the derivation tells them nothing new. It is **not a spending
  key**: closing needs `owner_sk`, liquidating needs a registered keeper's
  `require_auth`.
- `leaf_index` / `queue_index` are assigned by the contract. Including them
  makes every nullifier unique, even if a trader reuses a secret.
- Close and liquidate produce the **same position nullifier**, so whichever
  lands first wins.
- The circuit copies `owner_pk` from the order into the position, so a keeper
  can't assign the position to anyone else.

**Ciphertexts** (posted as events, each proven correct in-circuit; this is
**verifiable encryption**):
```
R = r·G,  S = r·recipient_pk,  E[i] = data[i] + Poseidon(S, i)
```

| Ciphertext | Posted by | Encrypted to | Protects |
|---|---|---|---|
| Order data | trader, in `create_order` | keeper view key | Keepers can always execute or liquidate |
| Position data (entry price, indices, fees, `leaf_index`) | keeper, in `execute_order` | `owner_pk` | Trader can always close, and recover on a new device; keeper can't post garbage |
| Blinding factors of accumulator deltas | prover of each delta | keeper view key **and** governance recovery key | Totals can be revealed even if all keepers are gone (§10) |

### 5.1 Poseidon: circuit and host must agree

CAP-0075's `poseidon_permutation` host function takes **every parameter from
the caller**: width `t`, S-box degree, full and partial round counts, MDS
matrix and round constants. Inputs ≥ the field modulus are **silently
reduced**. If the contract's parameters differ from the circuit library's,
every Merkle root and commitment silently disagrees.

`crates/zkperp-poseidon` implements circomlib's Poseidon for 1, 2 and 4 inputs
(t = 2, 3, 5; x⁵ S-box; 8 full rounds; 56/57/60 partial rounds) on the host
function, with constants generated from circomlibjs 0.1.7
(`crates/zkperp-poseidon/gen`).

**Result (2026-10-16): the host function matches circomlibjs exactly.** All 9
test vectors agree, including `Poseidon([1,2]) = 0x115cc0…189a` and edge cases
at `r − 1`. The convention is: state `[0, inputs…]`, output `state[0]`,
constants and MDS matrix passed exactly as circomlibjs stores them (no
transposing). A negative control (transposed MDS) gives a different output, so
the test can catch a mismatch. Inputs `≥ r` are rejected before the host call.
The functions sit behind soroban-sdk's `hazmat-crypto` feature
(`env.crypto_hazmat()`). `soroban-poseidon` 28.0.0 also exists but requires a
newer SDK; it hasn't been evaluated.

## 6. Commitment tree and pending queue

Proving an insertion (`old_root → new_root`) inside a trader's proof ties the
proof to one exact tree state. Concurrent proofs then conflict, and everything
serializes. Instead:

1. **Membership is proven against any recent root.** The contract keeps a
   short root history, so proofs made a few ledgers ago are still valid.
2. **Nullifiers are checked and recorded immediately.** Double-spend
   protection never waits for insertion.
3. **New commitments go into an on-chain pending queue** (append-only, just
   storage writes, no hashing).
4. **The designated keeper proves `insert_batch`**: the next k queued
   commitments, in queue order, take the tree from the current root to
   `new_root`. The contract checks that the queue segment matches and advances
   the root. One proof covers many insertions.

Consequences:
- A queued commitment can't be spent through a Merkle path until inserted.
  That's fine, because keepers execute orders anyway.
- `cancel_order` proves the order by its **queue index**, checked directly
  against on-chain queue storage, so it works even if nothing gets inserted.

## 7. Order flow (GMX-style two-step)

Traders never pick the execution price. They create an order, and a keeper
executes it with the next oracle price.

1. **Create order (trader).** Proves `create_order`: spends collateral notes
   (for increase orders) and queues an `order_commitment` plus the order
   ciphertext. The contract records the order's creation ledger.
2. **Execute (keeper).** Fetches a price report newer than the order, proves
   `execute_order`, and submits it with the report. The proof covers: position
   created or updated within `acceptable_price`; fees, funding and borrow
   applied; accumulator deltas; owner ciphertext. The new position commitment
   goes into the queue.
3. **Cancel.** If no keeper executes within N ledgers, the trader cancels by
   queue index and gets the escrowed notes back.

**Close** is a decrease order through the same two-step flow. Realised PnL
lands in a new note for the trader and in the hidden pool accumulators.
**Liquidation** is single-step by a keeper, with a fresh price report.

## 8. GMX-style pool with hidden accounting

LPs deposit the pool asset. Start with **one market and one pool**, for example
XLM/USD with USDC collateral, like GLP v1. The pool is the counterparty to
every trade.

**Every amount that depends on a trade's size is hidden**, not only open
interest:

| Accumulator | Changed by |
|---|---|
| long size, short size | execute, close, liquidate |
| long Σsize·entry, short Σsize·entry | execute, close, liquidate |
| pool assets (LP-owned value) | realised PnL on close, liquidation proceeds, fee share, LP deposit/withdraw |
| total trader collateral | execute, close, liquidate |
| fees collected (pool share, keeper share) | execute, close, liquidate |

**How the accumulators work:**
- For each total `A`, the contract keeps a Pedersen commitment on BabyJubJub:
  `C_A = A·G + b·H`.
- Every proof that changes a total outputs a delta `ΔC = δ·G + β·H`. The
  circuit proves `δ` is correct, and `β` goes into ciphertexts (§5). The
  contract adds the point: `C_A ← C_A + ΔC`. Addition uses the BN254
  `fr_add`/`fr_mul`/`fr_inv` host functions, because BabyJubJub coordinates
  live in BN254's scalar field.
- Once per **epoch** (for example every 10 minutes), the designated keeper
  calls `reveal(A, Σb)` for each total. The contract checks
  `C_A == A·G + Σb·H` and stores the plaintext totals. Keepers can't misreport.

**Solvency without OI totals (adopted from zkperp-midnight, built in
`contracts/zkperp-vault`).** Every position's profit is capped at one public
constant `max_payout`, and each open position reserves exactly that much:
`reserved = live_positions × max_payout`, with the invariant
`pool_value > reserved`. That keeps every profit payable using only the
position count, which is public anyway. The hidden totals below are still
needed for LP pricing and funding, but not for solvency.

**What the revealed totals drive:**
- **LP share price** = pool assets − traders' net unrealized PnL at the oracle
  price (computed on-chain from the totals)
- **borrow and funding indices** (skew-based, as in GMX v2)
- **OI caps** (below)
- **keeper compensation** (§3)

**LP deposits and withdrawals** are two-step: requested, then executed after
the next reveal at that epoch's share price.

**OI cap between reveals.** A per-order maximum alone lets OI overshoot by
N × the maximum. Instead, the contract counts executions that increase OI in
the current epoch and enforces:
```
revealed_OI_side + increases_this_epoch × max_order_size ≤ cap_side
```
This leaks nothing new, because executions are visible transactions anyway.
Near the cap it throttles execution until the next reveal.

**What leaks:** the totals once per epoch. That's less than GMX, which shows
them continuously. When an epoch has few trades, the change between reveals
still says a lot about those trades, so the epoch length is the privacy
setting.

## 9. Circuits

| Circuit | Prover | Key public inputs | Proves |
|---|---|---|---|
| **deposit** | trader | `note_commitment`, `asset`, `amount` | Commitment matches the deposited amount |
| **create_order** | trader | `root`, note nullifiers, `order_commitment`, change note, `H(ciphertexts)`, `view_pk` | Notes are owned and unspent. Order is well-formed. Order ciphertext is correct. |
| **execute_order** | keeper | `root` or queue index, order/position nullifiers, new `position_commitment`, `price`, indices, `H(ΔC points)`, `H(ciphertexts)` | Price within `acceptable_price`. Position math, fees, funding and PnL are correct. Deltas match. Owner ciphertext is correct. `owner_pk` copied from the order. |
| **cancel_order** | trader | queue index, order nullifier, refund note | Caller owns the queued order |
| **liquidate** | keeper | `root`, `position_nullifier`, `price`, indices, `H(ΔC points)`, residual note, `H(ciphertexts)` | Margin < maintenance at `price`. Collateral is split between the pool, the keeper fee accumulator and a residual note for the trader. |
| **insert_batch** | keeper | `old_root`, `new_root`, `H(queue segment)` | The queued commitments are inserted in order |
| **withdraw** | trader | `root`, `note_nullifier`, `asset`, `amount`, `recipient` | Note is owned. Amount leaves the shielded pool. |

No circuit has a fee, payout or PnL amount as a public input; those only
appear inside hidden deltas.

Design rules:
- **Hash ciphertexts, delta points and queue segments into one public input
  each.** The contract recomputes the hash with the Poseidon host function.
  Each extra public input costs about 0.35M instructions.
- Keepers do most of the proving. Trader devices only prove `create_order`,
  `cancel_order`, `deposit` and `withdraw`.

## 10. Escape hatches

Keepers gate execution, liquidation, insertion and reveals. If **all three**
are unresponsive for N ledgers:

| Function | Fallback |
|---|---|
| Order execution | Trader cancels by queue index and gets notes back |
| Tree insertion | **Anyone** may submit `insert_batch` (the queue is public; the proof only needs public commitments) |
| Epoch reveal | **Governance** opens the totals with the recovery key from the blinding-factor ciphertexts (§5) |
| Liquidation | None without keeper data. Bad-debt risk, see §14 |
| Withdrawal of inserted notes | Always available to the owner |

## 11. Contract checks (binding public inputs)

Every public input a proof depends on must be checked against something the
contract trusts.

- [ ] `root` is in the recent-root history; queue indices exist in storage.
- [ ] `insert_batch` covers exactly the next queued entries, in order.
- [ ] Every nullifier is unused, then gets recorded. Nullifier storage must
      never expire (extend its TTL). If missing storage reads as "unspent", an
      archived entry would let someone spend twice.
- [ ] Every scalar public input and every Poseidon input is `< r`.
      `Bn254Fr::from(U256)` and `poseidon_permutation` both silently reduce
      mod `r` (confirmed in soroban-sdk 26.1.1).
- [ ] The contract's Poseidon parameters match the circuits' exactly
      (§5.1, tested against circomlibjs vectors).
- [ ] `price` comes from a verified oracle report: right feed, timestamp after
      the order's creation, within the staleness bound, within the
      circuit-breaker band.
- [ ] Funding and borrow indices equal the contract's current values.
- [ ] `view_pk` equals the registered keeper view key.
- [ ] `keeper.require_auth()` is called and `keeper` is registered, for every
      keeper action.
- [ ] `H(ciphertexts)`, `H(ΔC points)` and `H(queue segment)` match the
      contract's own recomputed hashes.
- [ ] A reveal opening matches the accumulated commitment.
- [ ] The OI throttle (§8) holds before any execution that increases OI.
- [ ] `asset`, `amount` and `recipient` match the actual token transfer.
- [ ] Verification-key, keeper and view-key changes go through a timelock.
- [ ] Contract initialization can't be front-run (configuration in the
      constructor).

## 12. Throughput and cost

Measured (soroban-sdk 26.1.1, compiled WASM, `wasm_verify_cost` test):

| | Old `g1_mul`/`g1_add` loop | `g1_msm` |
|---|---|---|
| Groth16 verify, 2 public inputs | 27.2M instructions | 27.1M |
| Groth16 verify, 19 public inputs | 47.3M | 33.0M |

Network limits (testnet, read live with `stellar network settings`):
`tx_max_instructions` 400M, `ledger_max_instructions` 580M, 3 parallel
clusters, 5-second ledgers. All trades write the same contract state, so they
run one after another in a single cluster.

With the pending queue, trade proofs no longer conflict with each other. A
trade costs roughly one Groth16 verify plus storage writes, oracle
verification and accumulator additions. One `insert_batch` per ledger (or per
few ledgers) covers all queued commitments.

Poseidon (compiled WASM, including building the constant vectors on every
call): 2.2M instructions for 1 input, **3.0M for 2 inputs** (a Merkle node),
4.9M for 4 inputs. Hashing a depth-20 path on-chain would cost about 60M per
insertion, which is why insertions are proven in `insert_batch` (§6). Hashing
ciphertexts and delta points into one public input (§9) costs a few million.

Still to measure: oracle report verification, a BabyJubJub point addition, an
epoch reveal, and the full `execute_order` transaction.

## 13. Privacy: what still leaks

| What | Visible? | Mitigation |
|---|---|---|
| Position fields, owner | No | — |
| Which position closed or was liquidated | No (nullifier only) | — |
| Per-trade size, direction, fee, realised PnL, liquidation payout | No (hidden accumulator deltas) | — |
| Pool totals (OI, pool assets, fees) | **Per epoch** | Longer epochs |
| Deposit / withdraw amount, timing, address | **Yes** | Fixed denominations, delays |
| Fee-paying account on `create_order` / `cancel_order` | **Yes**, links a trader's orders | Keepers relay order creation |
| Which execution belongs to which order (timing) | **Yes**: the ledger shows an order being created, then an execution shortly after | Keepers execute in batches; relay order creation |
| Number of executions and liquidations per epoch | Yes | Batch several per transaction |
| Everything, to keepers | Yes, by design | Rotate the view key; operational controls |

## 14. Testnet experiment (20 agents)

**Not part of the hackathon.** Planned for afterwards; the hackathon uses
only the wallets in `docs/1_setup wallets and .env.md`.

- Deploy: verifier (MSM), perp contract, test SEP-41 token (USDC stand-in),
  mock pull oracle, 3 keeper addresses, a view key and a recovery key. Script
  all of it, because testnet resets periodically.
- Agents: 20 bots creating and cancelling orders at random, funded with
  Friendbot. Seed LPs deposit into the pool.
- Keepers: 3 independent processes, each with its own indexer.
- Scenarios:
  1. normal trading
  2. an oracle crash that triggers a wave of liquidations
  3. **killing 1, 2, then all 3 keepers**, to test takeover and the escape
     hatches
  4. an LP withdrawal across an epoch reveal
  5. pushing OI to the cap, to test the throttle
- Measure:
  - instructions per transaction type, from compiled WASM
  - orders executed per ledger
  - failures by cause
  - order-execution, insertion and liquidation latency
  - backup-keeper takeover time
  - proving time per circuit
  - how much each epoch's change in totals reveals at this volume

## 15. Open questions

- Chainlink Data Streams vs Pyth Pro: testnet availability, report
  verification cost on Soroban, Data Streams licensing.
- Epoch length: privacy vs how stale LP pricing and OI caps get.
- Funding: GMX v2 skew-based funding vs borrow fee only for the first version.
- Bad debt: who absorbs a position that is liquidated too late, including when
  all keepers are down (pool, or an insurance fund).
- Governance recovery key: who holds it, and under which conditions it may be
  used.
- Keeper relaying of order creation: removes the fee-payer link, but adds a
  second censorship point.
- Trusted setup: a production multi-party ceremony for every circuit.
