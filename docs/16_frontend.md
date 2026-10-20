# 16. Frontend

A browser app for ZKPerp on Soroban, modelled on zkperp-midnight's frontend:
the same dark "trading terminal" design, the same pages (**Public, Trade,
Portfolio, Liquidity, Faucet**) and the same privacy explanations. Trades are
proven **in the browser** and submitted by the relayer.

```sh
cd frontend
npm install
npm run dev          # syncs config + proving files, then http://localhost:5174 (reachable from Windows)
```
The backend (oracle signers, keepers, relayer) should be running under pm2
(steps 14–15): `cd circuits && pm2 start services/ecosystem.config.cjs`.

## 16.1 Stack

| | |
|---|---|
| App | Vite 6.4.3, React 19.3, react-router 7.18, TypeScript 5.9 (the versions zkperp-midnight runs) |
| Chart | lightweight-charts 5.2.1: Coinbase BTC-USD candles (REST + live WebSocket ticker), as on Midnight |
| Wallet | Freighter (`@stellar/freighter-api` 6.0.1), testnet |
| Chain | `@stellar/stellar-sdk` 17.2.0: the vault through the SDK's typed contract client (spec read from chain); the mUSDC token and faucet by hand |
| ZK | snarkjs 0.7.5 + circomlibjs 0.1.7 in the browser, using **the same code as the CLI and services**: `circuits/lib`, aliased as `@zk` |
| Backend | `/svc/relay`, `/svc/oracle/1-3`, `/svc/keeper/1-3`, proxied by the Vite dev server to the pm2 services (same-origin, no CORS), as Midnight's frontend does |

`circuits/lib` was made isomorphic for this:
- key files come from `circuits/keys/` in Node, or from `ZKPERP_KEYS_URL` (`/zk/`) in the browser;
- randomness uses `crypto.getRandomValues`;
- SHA-256 comes from the Stellar SDK;
- the CLI-only leaf fetching moved to `tree-fetch.mjs`.

All Node tests still pass after the change.

`npm run sync` (`scripts/sync.mjs`) writes `public/config.json` from an
**explicit allow-list of public `.env` values** (it refuses any `*SECRET` /
`*SK`; the browser uses the public SDF RPC) and copies the 7 circuits the
browser proves with into `public/zk/` (79 MB, gitignored).

## 16.2 Pages

| Page | Shows | Actions |
|---|---|---|
| **Public** | Pool liquidity and zLP price; reserved slots (meter); open positions; mark price, age and signers (meter); the on-chain price as a step line (`price_set` events); live activity feed (what the chain shows for each event); "How a private trade moves"; Public / Private split; backend health (oracle signers, keepers, relayer) | — |
| **Trade** | Market header (live price, change, execution price, deviation, oracle age); candles with the execution line (dashed violet) and your SL / TP / limit levels (dotted); deviation warning; your open private positions (PnL now, liquidation ≈, you receive); privacy inspector | **Market / Limit**, **Long / Short**, collateral from your private notes, leverage 1–20×, summary (size, entry, fees, borrow per hour), risk (liquidation price, max loss, max profit at the cap), confirm → prove in browser → relay; Close |
| **Portfolio** | Private balance (notes), open positions as cards (size, collateral, entry, mark, liquidation, PnL, if closed now, fees to close), limit orders, history (closed / liquidated / stop loss / take profit), "where your positions live" | **Shield** mUSDC into a note (wallet signs), **Unshield** to any address (relayer); Close; **Set / Move / Cancel stop loss and take profit**; cancel limit orders; **Download / Import backup**. Syncs automatically to pick up keeper fills, liquidations and executed orders, and recovers their payout notes |
| **Liquidity** | Pool value, zLP share price, reserved, withdrawable; "How LP returns work"; your zLP, worth, share | **Deposit / Withdraw** (wallet signs). Deposit **from wallet** or **from private balance** (the relayer unshields one note to your own wallet, then the wallet signs the deposit; this links the amount to your account). LP stays public by design: private LP was considered and left out for now |
| **Faucet** | Balance, trustline and XLM checks; setup steps | **Mint** mUSDC (adds the trustline first if missing) |

Header: brand, network chip, nav, a **vault picker** (the real vault on live
Chainlink, or the demo vault on test prices), a price ticker (red when
stale), and the wallet button. A full-width banner appears when the oracle
price is past its 65-minute limit.

## 16.3 Keys and privacy in the browser

- **Position key: password + wallet account**, as on Midnight.
  PBKDF2-SHA256 (WebCrypto, 600,000 iterations) derives the owner secret and an
  AES-GCM storage key. It isn't derived from a wallet signature, because any
  site could ask Freighter for the same signature. "First time? Generate a
  password" gives six random words, with "I have saved this password". The key
  lives in page memory only.
- **Your records** (notes, positions, orders, limits) are stored **encrypted**
  in this browser (`localStorage`, per vault and key). "Download backup" saves
  the ciphertext; import it on another computer with the same wallet and
  password.
- **What signs what:**
  - Freighter signs only public steps: faucet, trustline, LP deposit and
    withdraw, shielding.
  - Opens, closes, orders, limit orders and unshielding are proven in the
    page and submitted by the **relayer**, so your account never appears in
    them.
- **Update (step 17):** records are now also posted encrypted to a memo board on chain, so the same wallet + password restores them on any computer; see `17_records_on_chain.md`. The text below describes the state before that.
- **Difference from Midnight:** Midnight can rebuild positions on any
  computer from encrypted notes it writes on chain. Here the trader's own copy
  lives in the browser plus the backup file. An on-chain owner ciphertext
  (like the keeper note) would add that recovery.

## 16.4 Tested (2026-10-16)

In Chrome against the real vault, with the pm2 backend running:
- **Public:** pool 20,044 mUSDC, zLP 1.0007, 0 open positions, mark
  $81,276.82 signed by 1 + 2 (a Chainlink round the step-15 oracle servers
  had just submitted on their own), activity feed and price line from events,
  3 of 3 keepers up.
- **Trade:** live Coinbase candles with the execution line; deviation −0.23%.
  Order form: 100 mUSDC at 5× → size 497.51, fee 0.50, liquidation
  ≈ $67,135 (−17.4%), max profit 5,000.
- **Liquidity:** share price 1.000699 (the step-9 fee collection), withdrawable 20,044.
- **Faucet:** detects Freighter.
- **Proving in the browser:** run in the page through the app's own modules
  - `cancel_limit`: proved in **191 ms**, verified;
  - `open_private` (26k constraints, 12 MB key): proved in **963 ms**,
    verified, change note correct.
- `npx tsc --noEmit` clean; `vite build` succeeds.

Fixed during testing:
- Freighter's CommonJS export (its API sits on `default` under Vite);
- the polyfill shims and duplicated dependencies when bundling `circuits/lib`
  (`resolve.dedupe` + shim aliases);
- Vite copying every `.zkey` into the bundle;
- **the faucet's trustline** ("unsupported operation type:
  OperationTypeChangeTrust"): `submit` simulated every transaction, but a
  trustline is a classic operation. Only contract calls are prepared now
  (stellar-sdk 17: `op.body.type === "invokeHostFunction"`). Checked on testnet
  with a throwaway account: trustline, then mint 5,000 → both SUCCESS;
- the Public page's price axis cut off the last digit (81,27x showed as "8127");
- the Portfolio shield form and Liquidity card now show the **public wallet balance** (with Max), and say why a deposit is blocked (empty wallet, note too small) instead of "Enter an amount"; a failed account read shows its error instead of "Connect a wallet".

**Not exercised here:** the wallet-signed flows (connect, mint, shield,
deposit) and trades through the UI. They need the owner's Freighter approval;
the proving, relay and contract calls they use are the ones tested above and
in steps 3–13.
