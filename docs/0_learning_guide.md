# ZKPerp on Soroban: learning guide

Everything built on 2026-10-16, step by step, written to learn from. Each step
has its own detailed doc (`docs/1_…` to `docs/18_…`); this guide explains
**why** each step exists, **how** it works, **what to run**, and **what to take
away**, in the order it was built.

The project: **private perpetual futures** on Stellar Soroban testnet, ported
from the earlier Midnight version (`~/zkperp-midnight`). A trader goes long or
short on BTC/USD with leverage against a liquidity pool. Nobody, except three
trusted keepers, can see the trade's size, direction, collateral or owner.

---

## Part 1: The ideas you need first

Every later step reuses these few building blocks.

### 1.1 Commitment: a sealed envelope on chain

A **commitment** is a hash of secret values, e.g.
`commitment = Poseidon(isLong, size, collateral, entryPrice, openTime, openFee, ownerHash, salt)`.

- The chain stores only the hash. Without the values (and the random `salt`)
  nobody can tell what's inside.
- Later you can **prove** facts about what's inside without opening it.
- **Poseidon** is a hash designed to be cheap inside zero-knowledge circuits.
  Soroban has it as a host function (CAP-0075), so the contract computes the
  same hash cheaply.

### 1.2 The commitment tree: "this envelope exists"

All commitments (positions and notes) go into one **Merkle tree** of depth 20
(about a million leaves) inside the vault.

- To spend something, you prove "my commitment is a leaf of a tree whose root
  is R" **without saying which leaf**. That hides which deposit or position is
  yours.
- The vault keeps the last 32 roots, so a proof made against a slightly older
  root still works.
- **The leaves are stored in the contract** (`leaves(start, count)`), not only
  in events. Testnet RPC keeps events for only about a day, so anything a
  client needs later must be in storage. This rule comes back in steps 6, 8
  and 17.

### 1.3 Nullifier: "this envelope is now used"

When a note or position is spent, the transaction publishes
`nullifier = Poseidon(salt, leafIndex)`.

- The vault records every nullifier, so the same note can't be spent twice
  (`NoteSpent`).
- Nobody can link a nullifier to its leaf without the salt. So the public sees
  *that something was spent*, not *what*.

### 1.4 Zero-knowledge proof (Groth16)

A **circuit** (`circuits/*.circom`) states the rules: "the fee is exactly
0.1% of size", "leverage is between 1× and 20×", "this commitment is in the
tree and I know its owner secret".

- The trader's browser (or a script) runs **snarkjs** to make a small proof
  that the rules hold for their secret values.
- The vault verifies it with the **Groth16** verifier (`crates/groth16`).
- **Public inputs** are values the chain sees and checks: the price, the fee
  rate, the root, the commitment. **The contract takes them from its own
  storage**, never from the user. That way a proof made at another price or
  fee rate simply fails.
- **Trusted setup:** each circuit needs a proving key and a verification key.
  `scripts/setup.sh <circuit> [power]` makes them, single-party.
  - Whoever runs it could forge proofs, so it's fine for a hackathon, but
    production needs a multi-party ceremony.
  - `power` (14 or 15) must cover the circuit's size: 2^15 = 32,768
    constraints.

### 1.5 Verifiable encryption: the keeper note

Keepers must see every position, so they can liquidate it. At open, the
circuit also encrypts the position's fields to the keepers' **view key**:
BabyJubJub elliptic-curve Diffie-Hellman, then each field plus a
`Poseidon(sharedSecret, i)` pad.

- **Verifiable** means the proof shows the encryption is correct, so a trader
  can't post an unreadable note to dodge liquidation.
- All three keepers share one view key (`KEEPER_VIEW_SK` in `.env`).

### 1.6 Relayer: hide who sent it

A transaction's source account is public. Private actions (open, close,
orders, unshield) need no signature from the trader, because **the proof is
the authority**. Any account can submit them, so the **relayer** does.

- The relayer can't change anything: the proof binds every value, including
  the recipient of a withdrawal.
- All it can do is refuse.

### 1.7 The pool and its reservation (GMX-style, as on Midnight)

- LPs deposit mUSDC and get **zLP shares**. The pool is every trader's
  counterparty: it pays profits and receives losses.
- **Solvency without revealing sizes:** every profit is capped at one public
  constant, `max_payout` (5,000 mUSDC), and every open position reserves exactly
  that much.
  - GMX reserves each position's size, which would publish every size.
  - Reserving the same amount for every position keeps sizes hidden.

### 1.8 Who sees what (the whole design in one table)

| | Public | Keepers (3, trusted) | Trader |
|---|---|---|---|
| Pool size, LP deposits/withdrawals | ✓ | ✓ | ✓ |
| A position was opened / closed, the price, the PnL | ✓ | ✓ | ✓ |
| Size, direction, collateral, leverage, owner | ✗ | ✓ | ✓ |
| Stop loss / take profit / limit levels | ✗ | ✓ | ✓ |
| Which deposit funded which trade | ✗ | partly (owner hash) | ✓ |

---

## Part 2: The steps

Each step uses the same layout: **Goal → What we built → How it works → Run it
→ Learn from it**.

### Step 1: Wallets and `.env` (`1_setup wallets and .env.md`)

**Goal.** Accounts for every role, and one rule for secrets.

**What we built.**
- `.env` with `<ROLE>_ADDRESS` / `<ROLE>_SECRET` for each role: admin, mUSDC
  issuer, trader, relayer, oracle signers 1–3, keepers 1–3, LPs.
- `.env.example` with the same names and empty secrets, so it can be
  committed.

**How it works.**
- **No stellar CLI keystore.** Scripts pass a secret to the CLI through the
  `STELLAR_ACCOUNT` environment variable, so it never shows up as a command
  argument.
- By hand: `set -a; . ./.env; set +a`, then `--source "$ADMIN_SECRET"`.

**Learn from it.**
- Decide the secret-handling rule on day 1. Every later script follows it.
- Check that each secret derives its address (the loop in §1.5 of the doc).
  A mismatched pair produces confusing errors much later.
- `.env` is the only copy of generated keys. Losing `KEEPER_VIEW_SK` makes
  every keeper note unreadable, forever.

### Step 2: mUSDC, a mock stablecoin (`2_Mock USDC.md`)

**Goal.** Unlimited test collateral that behaves exactly like Circle's USDC.

**What we built.** A classic Stellar asset `mUSDC` with its **Stellar Asset
Contract (SAC)**, plus a tiny `musdc-faucet` contract that is the SAC's admin.
Anyone can call its `mint(to, amount)`.

**How it works.**
- 7 decimals: `1 mUSDC = 10_000_000` units.
- Classic accounts (`G…`) need a **trustline** before they can hold it;
  contracts (`C…`) don't.
- Switching to real USDC later is one config value (`COLLATERAL_SAC`).

**Run it.**
```sh
stellar tx new change-trust --source "$TRADER_SECRET" --line mUSDC:$MUSDC_ISSUER --network testnet
stellar contract invoke --id $MUSDC_FAUCET_ID --source "$TRADER_SECRET" --network testnet -- mint --to $TRADER_ADDRESS --amount 10000000000
```

**Learn from it.**
- Using a real SAC rather than a custom token means trustlines, errors (SAC
  error **#13** = no trustline) and decimals behave as on mainnet.
- Unlike Midnight's pUSDC, mUSDC balances are **public**. Privacy starts
  inside the vault (step 6), not in the token.

### Step 3: The LP vault (`3_create_LP_vault.md`)

**Goal.** The liquidity pool: deposit, withdraw, shares.

**What we built.** `contracts/zkperp-vault` with `deposit`, `withdraw`,
previews, `withdrawable`, `reserved`, and `upgrade`.

**How it works.**
- **Shares:** the first deposit mints 1:1, later ones pro rata, always
  **rounded down in the pool's favour**.
- `pool_value` is tracked inside the contract, not read from the token
  balance. That blocks the "inflation attack" (donating tokens to skew the
  share price).
- **Invariant:** `pool_value > live_positions × max_payout`, so LPs can't
  withdraw money reserved for open positions.
- `upgrade(wasm_hash)` keeps the address, balances and storage while
  replacing the code. Every later step was added to the **same** vault this
  way.

**Learn from it.**
- Rounding direction is a security decision: always round against the user,
  in the pool's favour.
- Design for upgrades from the start (admin-only `upgrade`, versioned
  `init_*` functions).

### Step 4: Open a long or short (`4_open_position.md`)

**Goal.** The first private trade.

**What we built.**
- Circuit `open_position.circom` (~12,700 constraints).
- Contract `open_position`.
- Merkle tree (`merkle.rs`).
- Shared crates: `zkperp-poseidon`, `groth16`.

**How it works.**
1. The trader reads the mark price and proves locally (~1.3 s). The proof
   covers: exact fee, leverage 1×–20×, the commitment, and a verifiable keeper
   note.
2. The vault checks:
   - the time (within 5 minutes);
   - a fresh price;
   - room in the pool;
   - every input below the field modulus `r`;
   - the proof, against **its stored price and fee rate**.
3. It then takes the collateral, reserves `max_payout` and inserts the
   commitment.

Longs and shorts use the same circuit and produce the same public shape, so
the direction doesn't leak.

**Learn from it.**
- **Check that inputs are below `r`.** The SDK silently reduces large numbers
  modulo `r`, which could let one proof match two different values
  (`NotInField`).
- **Measure cost early.** An open uses 56M of the 400M instruction budget
  (14%). Groth16 verification plus 20 Poseidon hashes fit comfortably on
  Soroban.
- **Library crates, not cargo features:** "library mode" feature flags broke
  under workspace feature unification, so shared code moved into separate
  crates.
- Still public here: the collateral and the trader's account. Step 6 fixes
  both.

### Step 5: Price oracle, 2-of-3 signed Chainlink (`5_price_oracle.md`)

**Goal.** A mark price no single party can fake.

**What we built.**
- `set_price` (two **ed25519** signatures over
  `sha256(xdr("zkp_price", vault, round, price, updated_at))`);
- `rotate_signer`;
- three signer services that read **Chainlink BTC/USD on Ethereum**.

**How it works.**
- Each signer signs every new Chainlink round and serves its signature on
  `/signature/<round>`.
- Signer *n* waits (n−1)×20 s, then fetches a peer's signature and submits
  both. Signer 1 normally submits; if it's down, signer 2 takes over.
- **Rules:**
  - rounds only move forward (no replay);
  - the vault address is in the message, so a report can't be used on
    another vault;
  - prices older than `max_price_age` (65 min) stop trading.

**Learn from it.**
- ed25519 is native and cheap on Soroban, and every Stellar account key is an
  ed25519 key, so a signer is just a Stellar account.
- **The price's age counts from when Chainlink observed it**, not from
  submission.
- Chainlink BTC/USD only updates on a 0.5% move or hourly, so the vault's
  price can lag the market by up to 0.5%. That's why the frontend shows a
  "Deviation".
- **Test prices go only on the demo vault** (`node scripts/price.mjs 75000`),
  never on the real vault: a fake round would block real Chainlink rounds.

### Step 6: Shielded collateral, private notes (`6_shielded_collateral.md`)

**Goal.** Hide the collateral and the trader's account too.

**What we built.**
- `deposit_note` (public shield-in).
- `open_position_private` and `withdraw_note`, both relayed with no
  signature.
- Circuits `open_private` (~26,300 constraints) and `withdraw_note`.
- The relay server.
- Leaves stored on chain, plus `backfill_leaves`.

**How it works.**
- A **note** is a private balance inside the vault:
  `commitment = Poseidon(amount, Poseidon(ownerHash, salt))`.
- The vault computes this hash itself from the deposited amount, so nobody can
  mint a note worth more than they paid.
- A private open spends a note (nullifier), creates the position and a
  **change note** with the rest.
- `trader_funds` tracks all trader money, so that
  `token balance = pool_value + trader_funds` at all times.

**Learn from it.**
- **On Stellar, token balances are public, so privacy has to live inside the
  contract.** Notes and nullifiers are the classic way to do that (as in
  Zcash and Tornado).
- **Still visible:** deposit and withdrawal amounts and accounts, and timing.
  With few users, timing can link a deposit to a trade (see "Privacy needs a
  crowd" below).
- Verifying the recipient inside the proof means the relayer can't redirect a
  withdrawal.

### Step 7: Close a position (`7_close_position.md`)

**Goal.** Settle a position against the pool at the mark price.

**What we built.** Circuit `close_position` (~17,000 constraints) and contract
`close_position`.

**How it works.**
- **Profit** is `floor(size × move / entry)`, capped at `max_payout`.
- **Loss** is `ceil(size × move / entry)`, at most the collateral.
- **Closing fee** is `ceil(size × fee_bps / 10000)`.
- **Payout** goes to the trader as a **new private note**.
- **Fees** go to a **treasury note**, not to the pool. Fees are proportional
  to size, so putting them in the pool would reveal the size.
- **The pool sees only the PnL** (`pool_in` / `pool_out`), and it is public.
- **Value is conserved:** `collateral + openFee = payout + fees + pool_in − pool_out`.

**Learn from it.**
- Write the conservation equation first and test it for every scenario
  (profit, loss, flat, capped, wiped out).
- **Circuits have no `if`:** every `min` or `select` is a constraint, as in
  Midnight's `settle`.
- **Remaining leak:** PnL ÷ price move ≈ size. Midnight has the same leak;
  hiding the pool's accounting per epoch would remove it.

### Step 8: Liquidation by keepers (`8_liquidation.md`)

**Goal.** Close positions that fell below the maintenance margin, without
their owner.

**What we built.**
- Circuit `liquidate_position` and contract `liquidate` (keeper must sign).
- The keeper service.
- `deploy-vault.mjs`, which deploys a fully initialized vault in one command.

**How it works.**
- **Below maintenance** means `equity × 10000 < size × 250` (2.5%). The
  liquidation fee is 0.5% of size.
- The keeper knows the owner *hash* and salt (from the keeper note), so it can
  create the owner's leftover-equity note with salt `Poseidon(salt, 2)`. The
  owner finds it alone, through `liquidation(nullifier)`.
- **Three keepers, staggered 20 s apart:** keeper 1 acts, the others take over
  if it's down. A duplicate fails on chain.
- **The keeper fee goes to the treasury, not to the keeper's wallet:** a
  public 0.5% fee would reveal the size.

**Learn from it.**
- **Deterministic salts:** `Poseidon(salt, k)` lets a third party create a note
  that the owner can later find, with no extra messages. Steps 11 and 13 reuse
  this.
- A position in profit can't be liquidated, and neither can a fresh 20×
  position (it starts with 5% equity, above 2.5%).
- Always run crash tests on the **demo vault** (`LIQ_DEMO_VAULT_ID`).

### Step 9: Treasury, merging fee notes and paying keepers (`9_treasury_fees.md`)

**Goal.** Turn the fee notes into LP income and keeper pay, without revealing
individual fees.

**What we built.**
- Circuit `merge_notes` (two notes into one).
- `collect_fees`: a withdraw proof whose recipient is the vault itself.
- `claim_keeper_fees`.

**How it works.**
1. Merge all fee notes privately.
2. Collect the total: 30% to keepers (equal shares), 70% to `pool_value`. No
   shares are minted, so every zLP gains value.
3. The treasury finds its notes by recomputing each fee from the keeper notes
   and the public exit price.

**Learn from it.**
- **Aggregate before you reveal:** collecting fee notes one by one would leak
  each position's fee, and so its size.
- **Three buckets** must always add up: `balance = pool_value + trader_funds + keeper_owed_total`.
- The first claim failed with SAC #13 (no trustline). The script now adds the
  trustline itself.

### Step 10: Borrow fee (`10_borrow_fee.md`)

**Goal.** Charge for time held, as on Midnight: 0.01% of size per hour
(`BORROW_RATE=27778`, per second, ×10¹²).

**How it works.**
- `borrowFee = ceil(size × rate × held / 10¹²)` is charged at close and at
  liquidation, together with the closing fee, and goes to the treasury note.
- The rate is a public proof input taken from storage, so a proof made at
  another rate fails.

**Learn from it.**
- **Exact ceilings in circuits:** prove
  `fee × 10¹² ≥ x > fee × 10¹² − 10¹²`, with comparisons wide enough (170
  bits) for the product.
- Changing a circuit means a new setup, new verification keys on chain
  (`set_close_config`, `set_liquidation_config`), and regenerated test
  fixtures.

### Step 11: Stop loss (`11_stop_loss.md`)

**Goal.** A keeper closes the position when the price crosses the trader's
stop level.

**What we built.**
- Circuits `order_auth` (place/cancel) and `execute_order`.
- Contract `place_order`, `cancel_order` and `execute_order`.
- The shared template `seal.circom` for verifiable encryption.

**How it works.**
- **Order id** = `Poseidon(position salt, kind, trigger, orderSalt)`. That's
  all the public sees.
- The level, the kind and the position are sealed to the keepers.
- **Firing rule** `below = isLong XOR kind`: a long's stop loss fires at
  mark ≤ stop.
- **Execution is a close at the mark price** (not at the level), with the
  payout salt `Poseidon(salt, 3)`.

**Learn from it.**
- Make the action (place = 1, cancel = 2) a public input, so a placement proof
  can't be replayed as a cancellation.
- **A 4-way truth-table test caught a real bug:** XOR had briefly become XNOR.
  Test every combination of direction × order type.

### Step 12: Take profit (`12_take_profit.md`)

**Goal.** The mirror of the stop loss.

**How it works.** It's the same mechanism with `kind = 1`: a long fires at
mark ≥ target. Profit is still capped at `max_payout`. Stop loss and take
profit can sit on the same position; whichever fires first spends the
nullifier and kills the other.

**Learn from it.** Build the general mechanism (a trigger order) once; the
specific features become parameters.

### Step 13: Limit orders (`13_limit_orders.md`)

**Goal.** Open a position only once the price reaches a level.

**What we built.**
- Circuits `place_limit`, `execute_limit` and `cancel_limit`.
- Contract `limits.rs`.

**How it works.**
- **Placing** spends a note and creates a sealed order commitment; the
  collateral stays in escrow inside `trader_funds`.
- **Filling:** a keeper opens the position **at the mark price** under the
  normal open rules. The position's salt is `Poseidon(orderSalt, 4)`, so the
  owner and every keeper rebuild the position from the fill record alone.
- **Cancelling** refunds a note with salt `Poseidon(orderSalt, 5)`.

**Learn from it.**
- Deterministic salts again: **no extra keeper note is needed at the fill**.
- **Event scans overlap**, so make handlers idempotent. The keeper logged new
  orders twice until each event was handled once per scan.

### Step 14: Keeper backend server (`14_keeper_server.md`)

**Goal.** Run the keepers as real services: supervised, observable, restartable.

**What we built.**
- `services/keeper-server.mjs`: HTTP `/health` and Prometheus `/metrics` on
  ports 3041–3043.
- `services/worker.mjs`: the keeper loop in a **forked child process**.
- `ecosystem.config.cjs` for **pm2**.
- `services/status.mjs` for one status table.

**How it works.** The HTTP server answers in about 1 ms while the loop proves
and submits in the child. If the loop dies, the server exits and pm2 restarts
it.

**Learn from it.** Two failed designs before the one that worked:
1. **One process:** the loop's synchronous `stellar` CLI calls blocked HTTP for
   seconds, so a healthy keeper showed as DOWN.
2. **A worker thread:** snarkjs's own `web-worker` dependency must run on a
   main thread, so it crashed.
3. **A forked child process** fixed both, and a test (`fork.test.mjs`) now
   proves and verifies inside a forked child.

The API exposes **counts only**, never decrypted positions, and binds to
127.0.0.1.

### Step 15: Price-oracle backend server (`15_oracle_server.md`)

**Goal.** The same treatment for the three oracle signers.

**What we built.** `services/oracle-server.mjs` on ports 3020–3022:
`/signature/<round>` (for peers), `/health`, `/price` (Chainlink vs vault) and
`/metrics`, also with the loop in a child process.

**Learn from it.**
- Here responsiveness matters even more: peers fetch signatures with a 3 s
  timeout, so a blocked signer delays the whole quorum.
- **Operations rule:** if all three signers are down for 65 minutes, trading
  stops. Alert on `zkperp_oracle_vault_price_age_seconds > 3000`.

### Step 16: The frontend (`16_frontend.md`)

**Goal.** A browser app like zkperp-midnight's: Public, Trade, Portfolio,
Liquidity, Faucet.

**What we built.** `frontend/`: Vite + React 19 + lightweight-charts +
Freighter wallet + stellar-sdk 17 + snarkjs in the browser.

**How it works.**
- **The same ZK code runs everywhere.** `circuits/lib` was made isomorphic
  (Node and browser) and is imported as `@zk`. It uses
  `crypto.getRandomValues`, SHA-256 from stellar-sdk, and key files from
  `/zk/`.
- **Proving happens in the browser:** `open_private` takes about 1 s.
- **Freighter signs only public steps:** faucet, trustline, LP
  deposit/withdraw, shielding. Everything private goes through the relayer.
- **Position key = wallet account + password** (PBKDF2, 600k iterations), as
  on Midnight. It isn't derived from a wallet signature, because any website
  could ask Freighter for the same signature.
- `npm run dev` runs `scripts/sync.mjs`. It writes `public/config.json` from an
  **allow-list of public `.env` keys** (it refuses `*SECRET` / `*SK`) and copies
  the proving files (79 MB, gitignored).
- The Vite dev server proxies `/svc/relay`, `/svc/oracle/n` and
  `/svc/keeper/n` to the pm2 services.

**Bugs fixed today, and what each teaches.**

| Symptom | Cause | Lesson |
|---|---|---|
| `vite build`: "Could not load …polyfills/shims/buffer" | `circuits/lib` lives outside `frontend/`, so its imports resolved from `circuits/node_modules` | `resolve.dedupe` + aliases for the polyfill shims when sharing code across packages |
| Build copied every `.zkey` (hundreds of MB) | `new URL("../keys/" + file, import.meta.url)` with a literal path makes Vite bundle the files | Build such paths from a variable |
| Freighter "not installed" | `@stellar/freighter-api` is CommonJS; under Vite its API sits on `.default` | Check CJS/ESM interop for wallet SDKs |
| Faucet: "unsupported operation type: OperationTypeChangeTrust" | Every transaction went through `prepareTransaction` (Soroban **simulation**); a trustline is a **classic** operation | Simulate only contract calls (`op.body.type === "invokeHostFunction"`); in stellar-sdk 17 the op body is a plain object, not an XDR accessor |
| Price axis showed "8127" | The chart cut off the labels' last digit | Leave room for labels; format numbers |
| "I don't see my balance" after minting | Minted mUSDC is a **public wallet** balance; the Portfolio showed only private notes | Show both balances, and say why a button is disabled |
| Liquidity card said "connect a wallet" while connected | A failed RPC read was shown as "no wallet" | Show loading and error states; never hide an error |

**Product decisions made today.**
- **LP deposits stay public, by design.** "From private balance" exists as a
  convenience (unshield to your wallet, then deposit), but it's **not**
  private.
- A trade was checked on chain: the open and the order were submitted and paid
  by the relayer, and **your account appears nowhere in either transaction**.
  The public LP deposit did show your account, as designed.

### Step 18: The relayer (`18_relayer.md`)

**Goal.** Document the relayer as a distinct role from the keepers, and explain
where to find private trader activity on the chain explorer.

**What we built.** `circuits/scripts/relay-server.mjs`, run under pm2 on
`:3030`, proxied by Vite at `/svc/relay`.

**How it works.**
- Private contract functions (`open_position_private`, `close_position`,
  `withdraw_note`, `place_order`, `place_limit`, …) require no `require_auth()`
  from the trader, because the **Groth16 proof is the authority**.
- The relayer is just a Stellar account that pays gas and submits the
  pre-built transaction. The trader's browser builds and proves the call; the
  relayer wraps it in a transaction and signs with `RELAYER_SECRET`.
- The relayer also posts encrypted memo-board records (`post_memo`) immediately
  after each action, so the trader can recover their notes on another device
  (step 17).

**Where to look on the explorer.**
- Private trader actions appear under `RELAYER_ADDRESS` on stellarchain.io —
  **not** under the trader's account.
- The trader's account appears only on `deposit_note` (public shield-in).
- The `post` operations interleaved with `open_position_private` are memo-board
  posts, not a separate action type.

**Keeper vs relayer** (the key distinction).

| | Keeper | Relayer |
|---|---|---|
| Registered in the vault | Yes | No |
| Has the view key | Yes | No |
| Initiates protocol actions | Yes (liquidate, execute orders) | No |
| Can censor | No (3 keepers, escape hatches) | Yes (single point today) |
| Can steal funds | No | No |

**Learn from it.**
- A relayer can't change what it submits: the proof covers every public input,
  including the withdrawal recipient.
- It *can* refuse to relay. A censored trader is stuck until the relayer
  restarts or a fallback is available. This is the main liveness risk.

---

### Step 17: Records on chain, log in from any computer (`17_records_on_chain.md`)

**Goal.** A Hyperliquid-like experience: trade on computer 1, connect the same
wallet on computer 2, and see everything.

**The problem.** A note's salt is random and exists only in the browser that
created it. A new computer can't rebuild it from the chain.

**What we built.**
- `contracts/memo-board`: an append-only list of encrypted blobs in
  **storage** (events expire in about a day).
- `frontend/src/lib/memos.ts`: post and scan.
- The relayer's `post_memo`.

**How it works.**
- **Posting:** about 1.5 s after your records change, the records not yet on
  chain are encrypted (AES-GCM under your position key), padded to 512 or
  1,024 bytes, and posted by the relayer.
- **Scanning:** on unlock and every 20 s.
  1. Trial-decrypt new memos; other people's fail the tag check.
  2. Place each record by finding its commitment in the tree.
  3. Ask the chain whether it's spent, closed or filled.
  4. Run `sync` for whatever keepers did.
- **Memos hold only secrets** (amounts, salts, levels). State always comes from
  the chain, so a stale memo can't mislead.

**Learn from it.**
- **Separate "secrets" from "state":** store the minimum the chain can't give
  back, and derive everything else.
- **Storage beats events** for anything you need later on Soroban testnet.
- **Post after the action**, in the background, so the trade isn't slowed
  down. Anything that fails to post is retried on the next change.
- **Privacy needs a crowd** (see Part 3).

---

## Part 3: Cross-cutting lessons

**Privacy needs a crowd.** Your trade was cryptographically private, but
you're almost the only testnet user. "This account shielded 5,000 at 16:56,
and four minutes later someone opened a private position" is a strong guess.
Say this openly in the demo; Zcash and Midnight have the same limit.

**Public vs private, decided per feature.**

| Public on purpose | Private |
|---|---|
| LP deposits/withdrawals, pool value, zLP | Positions (size, side, collateral, owner) |
| Mark price, PnL per close (the pool's change) | Payouts, fees, borrow fees (notes) |
| Shield-in / unshield amounts and accounts | Which note funded which trade |
| That an order exists (its id) | Order type, level, position |

**Testing pattern used throughout.**
- **Rust contract tests use real snarkjs proofs** as fixtures (`src/fixtures/*.json`,
  generated by `scripts/*-fixture.mjs`). The contract is tested against
  exactly what the circuits produce.
- **JS circuit tests** cover every rule and "can't be proven" cases (21×
  leverage, someone else's note, liquidating a healthy position).
- **Testnet dry runs:** a dry-run vault, then the demo vault for crashes, then
  the real vault.
- Totals today: **80 Rust tests, 22 JS tests**, all passing.

**Operations.**
- **pm2 runs 8 processes:** oracle-1..3, keeper-1..3, relay, and treasury
  (cron, daily at 03:00).
- Status: `node services/status.mjs`.
- Run commands from the right directory:
  `pm2 start services/ecosystem.config.cjs` only works inside `circuits/`.
- A transient `Connection reset by peer` from RPC happens; `lib/stellar.mjs`
  retries network errors up to 3 times.
- `setEnv` once glued a new key onto `.env`'s last line, which had no final
  newline. It now adds the newline first. **Always end text files with a
  newline.**

**Security notes.**
- Single-party trusted setups and an admin who can replace verification keys
  without a timelock: acceptable for a hackathon, not for mainnet.
- Keepers see everything (the trust assumption). Signers and keepers are all
  run by one operator today; production needs separate operators.
- Your position key = wallet + password. Anyone with both can read and spend
  your private notes.

---

## Part 4: Running it

```sh
# Backend (oracle signers, keepers, relayer, treasury)
cd ~/soroban-zkperp/circuits
pm2 start services/ecosystem.config.cjs      # or: pm2 restart services/ecosystem.config.cjs
node services/status.mjs                     # all "ok"?

# Frontend (second terminal)
cd ~/soroban-zkperp/frontend
npm run dev                                  # http://localhost:5174 (or the port it prints)

# Stop
pm2 stop all        # frontend: Ctrl+C
```

After changing `.env`: run `pm2 restart all` and restart `npm run dev` (it
syncs the frontend config on start).

## Part 5: A demo script for the hackathon (about 5 minutes)

1. **Public page:** pool, live Chainlink price signed by 2 of 3, activity feed.
   "Everything here is read from the chain. What you *don't* see is the
   point."
2. **Faucet:** mint 10,000 mUSDC (trustline + mint, Freighter signs).
3. **Portfolio:** unlock with a password, then **Shield** 5,000. "This is the
   last public step: the amount and my account are visible."
4. **Trade:** long, 500 collateral, 5×. "The proof is made in this browser in
   about one second; the relayer submits it; my wallet doesn't sign."
5. **Show it on chain:** the open transaction's source is the relayer, and the
   event holds only commitments. *(Use the Stellar explorer or the script from
   today.)*
6. **Stop loss:** set it on the position card. "Only the keepers can read the
   level."
7. **Second computer or private window:** same wallet, same password, and the
   position appears (step 17).
8. **Demo vault:** switch the vault picker, run
   `node scripts/price.mjs 75000`, and watch keeper 1 liquidate within
   seconds; the owner's leftover equity appears as a note.
9. **Close** a position on the real vault and show the PnL in the pool, with
   the payout private.

## Part 6: Glossary

| Term | Meaning here |
|---|---|
| Note | A private balance inside the vault (commitment of amount + owner) |
| Shield / unshield | Move mUSDC from your wallet into a note / from a note to any address |
| Commitment | Poseidon hash of secret values; what the chain stores |
| Nullifier | Published when a note/position is spent; prevents double spends |
| Root | Merkle root of all commitments; proofs say "my leaf is under this root" |
| Keeper note | The position's fields, verifiably encrypted to the keepers |
| Mark price | The vault's price: the latest 2-of-3 signed Chainlink round |
| `max_payout` | Profit cap per position (5,000 mUSDC) and the pool's reservation per position |
| zLP | LP shares of the pool |
| Relayer | The account that submits private transactions for everyone |
| Position key | Wallet account + password → owner secret + encryption key |
| Memo board | Contract holding encrypted copies of your records (step 17) |
| Demo vault | A second vault (`LIQ_DEMO_VAULT_ID`) where fake prices are allowed |

## Part 7: Map of the code

```
contracts/
  zkperp-vault/   the vault: LP (lib.rs), perp.rs, oracle.rs, merkle.rs, notes.rs,
                  close.rs, liquidate.rs, treasury.rs, orders.rs, limits.rs (+ test_*.rs)
  musdc-faucet/   mint mUSDC (step 2)
  memo-board/     encrypted records (step 17)
  poseidon/, zk-verifier/   standalone wrappers
crates/
  zkperp-poseidon/   circomlib-compatible Poseidon on the host function
  groth16/           Groth16 verification
circuits/
  *.circom           11 circuits + notes/seal/limit templates
  keys/              proving + verification keys (setup.sh)
  lib/               shared JS (Node + browser): notes, keeper crypto, orders, limits, stellar
  scripts/           CLI: open, close, order, limit, notes, price, deploy-vault, relay-server…
  services/          keeper-server, oracle-server, worker, status, ecosystem.config.cjs
  test/              JS circuit tests
frontend/
  src/lib/           chain, wallet, positionKey, store, trading, memos, relay, zk
  src/pages/         Public, Trade, Portfolio, Liquidity, Faucet
docs/                0 (this guide), 1–18 step docs, ARCHITECTURE.md
```
