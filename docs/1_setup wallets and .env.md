# 1. Set up wallets and `.env`

ZKPerp on testnet settles in one USDC-like asset: collateral, LP liquidity
and payouts all use it. For the hackathon that is **mUSDC**, a freely
mintable mock (step 2, `docs/2_Mock USDC.md`). **Circle's testnet USDC** is
documented here as the drop-in replacement for later; both have 7 decimals
and the same SEP-41 interface.

This step reuses existing testnet wallets from the `soroban-enable` project.
The 20-agent load test is out of scope for the hackathon.

## 1.1 Secrets live in `.env` (no stellar keystore)

- **Every key is in `.env`**, as `<ROLE>_ADDRESS` (public) and
  `<ROLE>_SECRET` (the `S…` secret key), the same convention as
  `~/soroban-enable/.env`. The stellar CLI keystore (`stellar keys`) is not
  used.
- `.env` is **gitignored** and mode 600. `.env.example` is committed: the same
  file with every `*_SECRET` (and `KEEPER_VIEW_SK`) left empty.
- Scripts in `circuits/` read secrets from `.env` and hand them to the stellar
  CLI through its `STELLAR_ACCOUNT` environment variable, so a secret never
  appears as a command-line argument.
- For commands typed by hand, load `.env` into the shell first and pass the
  secret as the source account:
  ```sh
  set -a; . ./.env; set +a            # from the repo root
  stellar contract invoke --id $VAULT_ID --source "$ADMIN_SECRET" --network testnet -- admin
  ```
  (`--source` accepts a secret key directly. It's visible to other local
  processes while the command runs, which is fine for testnet keys.)
- A private RPC URL (for example Alchemy) contains an API key: put it in
  `.env` only, never in `.env.example` or docs.
- Every secret's address was checked when it was written to `.env`: each
  `*_SECRET` derives exactly the `*_ADDRESS` next to it.

## 1.2 Network

| Setting | Value |
|---|---|
| Network | `testnet` |
| Passphrase | `Test SDF Network ; September 2015` |
| Soroban RPC | `https://soroban-testnet.stellar.org` (public SDF) or a private provider |
| Horizon | `https://horizon-testnet.stellar.org` |
| Instruction limit per tx | 400,000,000 (read live with `stellar network settings`, 2026-10-16) |

## 1.3 USDC on testnet

| | Value |
|---|---|
| Asset | `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (Circle testnet issuer) |
| Stellar Asset Contract (SAC) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| Decimals | 7 (`1 USDC = 10_000_000` units) |

The SAC ID was verified with
`stellar contract id asset --asset USDC:GBBD…FLA5 --network testnet`. Classic
accounts need a **USDC trustline** before they can hold USDC. More testnet
USDC is available from Circle's faucet (<https://faucet.circle.com>, Stellar
testnet), rate-limited.

## 1.4 Accounts

Existing wallets from `soroban-enable` (balances read from Horizon on
2026-10-16):

| ZKPerp role | `.env` names | Copy the secret from (`~/soroban-enable/.env`) | Address | XLM | USDC |
|---|---|---|---|---|---|
| Admin / governance / deployer | `ADMIN_ADDRESS`, `ADMIN_SECRET` | `ADMIN_SECRET` (**set**) | `GAESCDLAKL5BYVBQN27RWQY6AEKZBOWAIQ2T5CDLLHKX2SILU72TVVQB` | 9,971.7 | 226.0 |
| LP 1 | `LP_1_*` | `DEMO_MEMBER_SECRET` (fill when used) | `GC34EZWL5UNKCKYRAPDQ624LVKBF6JK6G3XOZWCMMZT7R5OZUOXZ6MEK` | 10,000 | 0 |
| LP 2 | `LP_2_*` | `DEMO_BEN_SECRET` | `GA2G7WRPNXVH5ZRB4SIYERFXBNJ42NRCHIDA76KJY3BXMCZH2ZK5VXAT` | 20,000 | 6.0 |
| LP 3 | `LP_3_*` | `DEMO_MERCHANT_SECRET` | `GDNRJJTBPN2USKVTHJF7SEWH6EW7JZEGDLZZA3636LL6O6JBLZ6LOZ7U` | 20,000 | 6.0 |

Accounts generated for ZKPerp in later steps (secrets already in `.env`):

| Role | `.env` names | Address | Created in |
|---|---|---|---|
| mUSDC issuer | `MUSDC_ISSUER`, `MUSDC_ISSUER_SECRET` | `GBIWTTMJLXFI4WKP4GSFOB7PH7S2FMHKBYOKYWMF4NSB6N6LZOGUB4FZ` | step 2 |
| Test trader / LP (seeded the pool, opened the test positions) | `TRADER_ADDRESS`, `TRADER_SECRET` | `GDPN2GCFZH4PLHG2Y7IAZNHVNOPJHEIZHDMAFOS4SEQUHQ4TD2A2NJHY` | step 2 |
| Oracle signers 1–3 | `ORACLE_n_ADDRESS`, `ORACLE_n_SECRET` | see step 5, §5.6 | step 5 |
| Relayer | `RELAYER_ADDRESS`, `RELAYER_SECRET` | see step 6 | step 6 |
| Keepers 1–3 (planned: `soroban-enable` `DEMO_SIGNER1..3`; their secrets weren't available, so new accounts) | `KEEPER_n_ADDRESS`, `KEEPER_n_SECRET` | see step 8, §8.6 | step 8 |

Keys that are not Stellar accounts:

| Key | `.env` names | Held by |
|---|---|---|
| Keeper view key (BabyJubJub) | `KEEPER_VIEW_SK` (secret), `KEEPER_VIEW_PK_X/Y` | Shared by the 3 keepers; public half registered in the vault |
| Trader position secrets | not in `.env`: one file per position in `.zkperp/positions/` (gitignored, mode 600) | The trader. Runtime data, not configuration: needed to close each position. |

Keepers, the relayer and the oracle signers only pay transaction fees in XLM, so they need no USDC trustline.

## 1.5 Steps

All commands run from the repo root in WSL.

**1. Create `.env`** from the template, then fill in secrets as needed:
```sh
cp .env.example .env && chmod 600 .env
```
For a `soroban-enable` wallet, copy the value of the listed variable (§1.4)
into the matching `*_SECRET`. To see it:
```sh
grep '^ADMIN_SECRET' ~/soroban-enable/.env
```
Paste only into `.env`, never into chats or docs.

**2. Check every filled secret matches its address:**
```sh
set -a; . ./.env; set +a
for r in ADMIN MUSDC_ISSUER TRADER RELAYER ORACLE_1 ORACLE_2 ORACLE_3 KEEPER_1 KEEPER_2 KEEPER_3 LP_1 LP_2 LP_3; do
  s=$(eval echo \$${r}_SECRET); [ -z "$s" ] && continue
  a=$(eval echo \$${r}_ADDRESS); [ "$r" = MUSDC_ISSUER ] && a=$MUSDC_ISSUER
  d=$(node -e 'console.log(require("./circuits/node_modules/@stellar/stellar-sdk").Keypair.fromSecret(process.argv[1]).publicKey())' "$s")
  [ "$d" = "$a" ] && echo "$r OK" || echo "$r MISMATCH"
done
```

**3. Fund LPs with mUSDC when needed** (step 2, §2.5): trustline + faucet
`mint`, signed with that LP's secret.

## 1.6 Caveats

- **Shared wallets.** Admin, signers and demo accounts are also used by
  `soroban-enable`. Don't run both projects' scripts at the same time: they
  would race on sequence numbers.
- **Testnet resets** (roughly quarterly) wipe every account and contract. The
  keys in `.env` stay valid, but the accounts must be re-funded (Friendbot),
  trustlines re-created and contracts redeployed.
- **`.env` is the only copy** of the generated accounts' secrets and of the
  keeper view key. Back it up somewhere private. Losing `KEEPER_VIEW_SK`
  makes every keeper note unreadable.
- These are testnet keys. Never reuse them on mainnet.
