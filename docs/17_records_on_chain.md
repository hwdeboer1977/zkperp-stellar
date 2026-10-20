# 17. Your records on chain (log in from any computer)

**Goal:** a Hyperliquid-like experience. Open a trade on computer 1, then
connect the same wallet on computer 2 and see the same positions, notes and
orders, with no backup file to move. Midnight already does this with
encrypted notes on chain; until now the Soroban frontend kept your records
only in the browser (step 16).

## 17.1 How it works

```
computer 1                                         memo board (contract)              computer 2
records change ─▶ encrypt (AES-GCM, position key) ─▶ post via the relayer ─▶ [memo 0, memo 1, …]
                                                                                   scan, trial-decrypt ─▶ your records
                                                                                   (others' memos fail the AES-GCM tag)
```

- **The position key** is the one from step 16: wallet account + password
  through PBKDF2 (600,000 iterations), as on Midnight. The same key on any
  computer decrypts the same memos.
- **Posting** (`frontend/src/lib/memos.ts`, `flush`): runs in the background
  1.5 s after your records change. Records that aren't on chain yet are packed
  into memos and posted **by the relayer** (`post_memo`), so your account never
  appears.
  - Each memo is padded to 512 or 1,024 bytes, so its size says little about
    its contents.
  - Trading isn't slowed down: the memo follows the action.
  - Records you had before this step are posted the first time you unlock.
- **Scanning** (`scan`): when you unlock, and every 20 seconds after that.
  1. Read the new memos and try to decrypt each with your key.
  2. Place each record by finding its **commitment** in the vault's tree,
     which gives its leaf number.
  3. Ask the chain whether it's **spent / closed / filled** (`is_spent`,
     `is_order_open`, `is_limit_open`, `limit_fill`).
  4. Run `sync` (step 16), which recovers whatever keepers did: liquidations,
     executed stop losses and take profits, filled limit orders.
- **What a memo holds:** only the secrets the chain can't give back (amounts,
  salts, position details, order levels). Spent/closed/filled state always
  comes from the chain, so an outdated memo can't mislead you.
  - Left out because any computer can rebuild them with `sync`: payout notes of
    liquidations and executed orders, and positions filled from your limit
    orders.
- **Safety:** a record is only shown if its commitment is in the vault's tree,
  so junk or a stray memo can't invent a note. Notes spent on the other
  computer are marked spent here (`is_spent`). If the other computer closed a
  position and its memo hasn't arrived yet, the position shows as closed with
  "…" until it does.

## 17.2 The memo board (`contracts/memo-board`)

| Function | Does |
|---|---|
| `post(data: Bytes) → u32` | Appends a memo (1-1,024 bytes); no signature needed |
| `count() → u32` | Number of memos |
| `get(start, n) → Vec<Bytes>` | Up to 50 memos from `start` |

- **Storage, not events:** testnet RPC keeps events for about a day, while
  persistent storage lasts as long as its rent (TTL) is paid. Each memo's TTL
  is extended to the network maximum when it's posted.
- **A separate contract:** the vault and its 64 tests are unchanged.
- 1.3 KB of WASM. Tests (`cargo test -p memo-board`): post and page through
  60 memos, the page cap of 50, empty and oversized memos rejected, no auth
  needed.

**Testnet:** `MEMO_BOARD_ID=CC67LIK2C6KC7FEEFWBWYA5Q32OV7V4STQBVFTTIZ6ST3CTKM7P2MLDZ`
(in `.env`, and in the frontend config through `scripts/sync.mjs`).

```sh
stellar contract build --package memo-board
STELLAR_ACCOUNT="$ADMIN_SECRET" stellar contract deploy --wasm target/wasm32v1-none/release/memo_board.wasm --network testnet
```

**Relayer:** `POST /relay {vault, fn: "post_memo", args: {data: <hex>}}` posts to
the board. It accepts only 1-1,024 bytes of hex. Restart it after adding
`MEMO_BOARD_ID`: `pm2 restart relay`.

## 17.3 Privacy

| | Visible? |
|---|---|
| That a memo was posted, its time and its size bucket (512 / 1,024) | Yes |
| Who posted it | No: always the relayer |
| Its contents, its owner, its type | No: AES-GCM under your position key; to anyone else it's random bytes |
| That a memo belongs with a trade | Only by timing: it is posted about 2 s after the action |

Anyone holding your **wallet account and password** can read your records on
any computer, so the password matters as much as it does on Midnight. Your
wallet alone isn't enough.

## 17.4 Tested (2026-10-16)

In Chrome (port 5174, a test account and throwaway password; the user's
records were not touched):
1. **Computer 1:** a record was added and posted in **one memo** through the
   relayer (board 0 → 1; a second flush posted nothing).
2. **Computer 2:** with browser storage and memory emptied, unlocking with the
   same account and password and scanning **restored the note** (amount
   123.00, the right leaf #0, unspent, "memo test").
3. **Another password:** restored nothing.

`cargo test -p memo-board`: 3 passed. `tsc` clean; `vite build` succeeds.

## 17.5 Limits

- **The relayer pays every memo:** one transaction per memo, up to ~6 records
  each. Anyone can post junk; it only costs scanners one failed decryption.
  A production version would rate-limit `post_memo`.
- **Scanning reads the whole board on a new computer:** 50 memos per call.
  That's fine for a hackathon; production would add an index or a view tag.
- **Rent:** memos last the network's maximum TTL; a long-lived deployment
  needs a job that extends it.
