# 2. Mock USDC (mUSDC)

ZKPerp settles in **mUSDC**, a mock stablecoin that **anyone can mint, in any
amount**. It replaces Circle's testnet USDC for the hackathon, because Circle's
faucet is rate-limited and the treasury in step 1 only holds about 226 USDC.

> ⚠️ **mUSDC is a mock token.** Anyone can mint any amount to any address. It
> has none of the supply control a real stablecoin needs. ZKPerp only accepts
> the one token it is deployed with, so switching to real USDC means deploying
> with Circle's USDC contract instead (§2.6).

This is the Soroban counterpart of `pUSDC` in `~/zkperp-midnight`
(`contracts/pusdc.compact`). The differences are deliberate:

| | Midnight `pUSDC` | Soroban `mUSDC` |
|---|---|---|
| Balances | Shielded (private) | **Public**, like any SEP-41 token |
| Where privacy starts | In the token | In the ZKPerp contract: deposited mUSDC becomes private notes. Only deposits and withdrawals are public. |
| Decimals | 6 (like USDC on EVM) | **7** (like USDC on Stellar): `1 mUSDC = 10_000_000` |
| Minting | `mint(amount)` / `mintTo(amount, recipient)`, anyone | `mint(to, amount)`, anyone |
| Recipient prerequisite | Encryption key mapping for `mintTo` | A **trustline** for classic accounts (G…); none for contracts (C…) |

## 2.1 Design

mUSDC is a **classic Stellar asset with a Stellar Asset Contract (SAC)**,
exactly like Circle's USDC. A small faucet contract is the SAC's **admin**,
and its `mint` lets anyone mint.

```
anyone ──mint(to, amount)──▶ musdc-faucet (SAC admin) ──mint──▶ mUSDC SAC ──▶ balance of `to`
```

Why a real SAC rather than a custom token contract:
- ZKPerp talks to the **same SEP-41 interface and the same 7 decimals** as
  real USDC, so the switch to real USDC is just a different contract address.
- Trustlines, balances and errors behave exactly as with real USDC, so the
  frontend handles the same cases on testnet as it would on mainnet.

After the admin handover, the issuer account has no role in minting. It only
remains the asset's issuer.

## 2.2 Contract

`contracts/musdc-faucet/src/lib.rs` (1.4 KB of WASM):

| Function | Description |
|---|---|
| `__constructor(sac)` | Stores the mUSDC SAC address |
| `mint(to, amount)` | Mints `amount` (> 0) to `to`. **No authorization required.** Fails with `InvalidAmount` (#1) if `amount ≤ 0`. Classic accounts without an mUSDC trustline make the SAC fail with error #13. |
| `sac()` | Returns the SAC address |

Tests (`cargo test -p musdc-faucet`): anyone can mint with no signatures, to
classic and contract addresses; non-positive amounts are rejected; minted mUSDC
transfers like any SEP-41 token.

## 2.3 Testnet deployment (2026-10-16)

| | Value |
|---|---|
| Asset | `mUSDC:GBIWTTMJLXFI4WKP4GSFOB7PH7S2FMHKBYOKYWMF4NSB6N6LZOGUB4FZ` |
| Issuer secret | `MUSDC_ISSUER_SECRET` in `.env` (account funded by Friendbot) |
| mUSDC SAC | `CBHTUBAWUPTL7PYMO556GAFS7PIFVF3VQZYNPXOQDSP6MHX4HD24NOMM` |
| Faucet contract | `CBDVQDAANRFPVIMY46GR67TXZ5LJYZY42YMVOJECBTQZOZUNH42O63LV` |
| SAC admin | the faucet contract (checked with `admin`) |
| Decimals | 7 |

Checks run on testnet after deployment, using the test trader account
(`TRADER_*` in `.env`), a new
account with no special rights:

| Check | Result |
|---|---|
| Add an mUSDC trustline, then `mint` 100 mUSDC to itself | Balance `1000000000` ✓ |
| `mint` to a contract address (the faucet itself), no trustline | Balance `10000000` ✓ |
| `mint` to a classic account without a trustline | Fails with SAC error #13 (missing trustline) ✓ |
| `decimals` / `name` | `7` / `mUSDC:GBIW…B4FZ` ✓ |

## 2.4 How it was deployed (reproducible)

```sh
set -a; . ./.env; set +a      # from the repo root (step 1, §1.1)

# 1. Issuer account: a new keypair, funded by Friendbot. Put both lines in .env.
node -e 'const k=require("./circuits/node_modules/@stellar/stellar-sdk").Keypair.random(); console.log("MUSDC_ISSUER="+k.publicKey()+"\nMUSDC_ISSUER_SECRET="+k.secret())'
set -a; . ./.env; set +a
curl -s "https://friendbot.stellar.org?addr=$MUSDC_ISSUER" > /dev/null

# 2. The SAC for mUSDC:<issuer>
SAC=$(stellar contract asset deploy --asset mUSDC:$MUSDC_ISSUER \
  --source "$MUSDC_ISSUER_SECRET" --network testnet)

# 3. The faucet, with the SAC address as constructor argument
stellar contract build --package musdc-faucet
FAUCET=$(stellar contract deploy --wasm target/wasm32v1-none/release/musdc_faucet.wasm \
  --source "$MUSDC_ISSUER_SECRET" --network testnet -- --sac $SAC)

# 4. Make the faucet the SAC admin (the only step that needs the issuer key)
stellar contract invoke --id $SAC --source "$MUSDC_ISSUER_SECRET" --network testnet \
  -- set_admin --new_admin $FAUCET
```

(The original deployment generated the issuer with `stellar keys generate`;
its secret has since moved to `.env` as `MUSDC_ISSUER_SECRET`.)

After a **testnet reset**, the issuer key in `.env` is still valid: re-fund it
with Friendbot and run steps 2–4 again. The SAC address is derived from the
asset, so it stays the same as long as the issuer does. A new issuer key means
a new asset, a new SAC address and a new faucet address. Update `.env`
afterwards (`MUSDC_*`, `COLLATERAL_SAC`).

## 2.5 Getting mUSDC

**Classic account** (G…): add a trustline once, then mint. Example for LP 1
(fill `LP_1_SECRET` in `.env` first):
```sh
set -a; . ./.env; set +a      # from the repo root (step 1, §1.1)

stellar tx new change-trust --source "$LP_1_SECRET" --line mUSDC:$MUSDC_ISSUER --network testnet
stellar contract invoke --id $MUSDC_FAUCET_ID --source "$LP_1_SECRET" --network testnet \
  -- mint --to $LP_1_ADDRESS --amount 10000000000   # 1,000 mUSDC
```

**Contract** (C…): no trustline needed. Mint directly to the contract address.

**Check a balance** (read-only; any funded account can be the source):
```sh
stellar contract invoke --id $MUSDC_SAC --source "$TRADER_SECRET" --network testnet \
  --send=no -- balance --id <address>
```

The faucet takes any `to`, so the caller pays the fee but the recipient can be
anyone. The recipient doesn't sign anything.

For the hackathon, mint whatever amounts make the demo readable (for example
LPs 10,000 mUSDC each, a trader 1,000). Since minting is free, the step-1 USDC
budget no longer constrains the demo.

## 2.6 Switching to real USDC later

ZKPerp reads its collateral token from configuration (`COLLATERAL_SAC` in
`.env`), not from code:

| | mUSDC (hackathon) | Circle USDC (later) |
|---|---|---|
| `COLLATERAL_SAC` | `CBHTUBAW…NOMM` | `CBIELTK6…DAMA` |
| Decimals | 7 | 7 |
| Trustline needed | `mUSDC:GBIW…B4FZ` | `USDC:GBBD…FLA5` |
| Getting tokens | `musdc-faucet.mint` | Circle faucet / transfers |

The amounts, interface and trustline handling are identical, so nothing else
changes. ZKPerp must be deployed with exactly one collateral SAC and reject
every other token.

## 2.7 Accounts created in this step

| `.env` names | Address | Purpose |
|---|---|---|
| `MUSDC_ISSUER`, `MUSDC_ISSUER_SECRET` | `GBIWTTMJLXFI4WKP4GSFOB7PH7S2FMHKBYOKYWMF4NSB6N6LZOGUB4FZ` | mUSDC issuer; deployed the SAC and the faucet |
| `TRADER_ADDRESS`, `TRADER_SECRET` | `GDPN2GCFZH4PLHG2Y7IAZNHVNOPJHEIZHDMAFOS4SEQUHQ4TD2A2NJHY` | Deployment checks here; later the test trader/LP (seeded the pool, opened the test positions) |

Both were generated with Friendbot funding. Their secrets are in `.env`
(gitignored), nowhere in the repo.
