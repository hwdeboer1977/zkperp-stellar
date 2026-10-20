# 18. The relayer

The relayer is a **gas-paying proxy** that submits private transactions on
behalf of traders. It has no protocol authority, no view key and no ability to
change what a transaction does. Its only job is to hide the trader's Stellar
address from the chain.

## 18.1 Why it exists

Every Stellar transaction has a **source account**, which is public. Private
actions — opening a position, closing, withdrawing, placing an order — must not
link to the trader. Soroban lets us solve this cleanly: because a **Groth16
proof is the authority**, the contract never calls `trader.require_auth()` on
these functions. Any account can submit them. The relayer is that account.

## 18.2 Keeper vs relayer

| | Keeper (×3) | Relayer (×1) |
|---|---|---|
| **Role** | Autonomous protocol bot | Trader's privacy proxy |
| **Authority** | Registered on-chain; must sign keeper actions | Not registered; no protocol role |
| **View key** | Holds `KEEPER_VIEW_SK`; can decrypt every position | Has no view key; sees only what the trader sends |
| **Actions it initiates** | Liquidations, order executions, limit fills, tree insertions | Nothing — it only submits what the trader proved |
| **Can it steal funds?** | No (circuit checks) | No (proof binds every value, including the recipient) |
| **Can it censor?** | No (other keepers take over; escape hatches exist) | Yes — refusing to relay is the only power it has |
| **On-chain account** | `KEEPER_n_ADDRESS` (registered in the vault) | `RELAYER_ADDRESS` (not registered; just pays gas) |

## 18.3 What it submits

| Contract function | Who proves it | Who submits it |
|---|---|---|
| `open_position_private` | Trader's browser (snarkjs) | Relayer |
| `close_position` | Trader's browser | Relayer |
| `withdraw_note` | Trader's browser | Relayer |
| `place_order` / `cancel_order` | Trader's browser | Relayer |
| `place_limit` / `cancel_limit` | Trader's browser | Relayer |
| `post_memo` (memo-board) | — | Relayer (encrypts and posts trader's records) |

The trader's wallet (Freighter) **does not sign** any of these. It signs only
public actions: faucet, trustline, LP deposit/withdraw, and `deposit_note`
(shielding). Everything else goes through the relayer.

## 18.4 What the relayer can and cannot do

**Can:**
- Choose not to relay (censorship). If the relayer is down, private actions
  queue until it restarts. There is no fallback submitter today.
- See the transaction arguments before submitting them (they're not encrypted
  to the relayer). It knows the nullifier, commitment, proof and public inputs,
  but nothing secret about the position.

**Cannot:**
- Change any value. The proof covers every public input, including the
  withdrawal recipient. Swapping `recipient` makes the proof fail on-chain.
- Redirect funds. Even if the relayer submits a modified call, the contract
  rejects it.
- Read positions. It has no view key.

## 18.5 How to find its transactions on the explorer

All private trader actions appear under the **relayer's address** on
stellarchain.io (testnet):

```
https://stellarchain.io/address/GAXINGVF53BYAGBYI4CYFINAAE5JMFM6WIKGRH4CHQNXMF5KUR7GJXFG?tab=operations
```

You will see:
- `open_position_private` — a trader opened a position
- `close_position` — a trader closed a position
- `withdraw_note` — a trader unshielded funds
- `place_order` / `cancel_order` / `place_limit` / `cancel_limit`
- `post` — the relayer posted an encrypted memo to the memo-board contract

The `post` and `open_position_private` are often paired: the relayer posts the
trader's updated records to the memo board right after the position opens, so
the trader can recover them on another computer (step 17).

The trader's own Stellar address (`TRADER_ADDRESS`) appears **only** on
`deposit_note` (the public shield-in step).

## 18.6 Running the relay server

The relay server runs under **pm2** alongside the keepers and oracles:

```sh
cd ~/soroban-zkperp/circuits
pm2 start services/ecosystem.config.cjs        # starts all 8 processes, incl. relay
pm2 start services/ecosystem.config.cjs --only relay   # relay only
pm2 logs relay                                 # live logs; also in .zkperp/logs/relay.out.log
```

The relay server listens on **`:3030`** and is proxied by the Vite dev server
at `/svc/relay`. In production, the reverse proxy handles that.

```sh
# Direct test (no pm2):
node circuits/scripts/relay-server.mjs
```

Key `.env` variables:
- `RELAYER_SECRET` — the submitting account's secret key
- `RELAYER_ADDRESS` — derived from it; for reference only
- `RELAYER_URL` — the URL the frontend calls (set to `http://localhost:3030`
  in dev; not needed when running the relay in the same process, e.g. in
  scripts)

## 18.7 Security notes

- The relayer is a **single point of censorship** today. Mainnet should have at
  least one fallback (a second relayer address, or a keeper that can relay on
  behalf of the trader).
- `RELAYER_SECRET` gives the ability to submit arbitrary contract calls (paying
  gas), but not to access funds. It is less sensitive than `KEEPER_VIEW_SK`,
  but should still be kept out of version control.
- The frontend's `sync.mjs` explicitly blocks all `*SECRET` and `*SK` keys
  from being written to `public/config.json`.
