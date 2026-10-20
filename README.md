# soroban-zkperp

Checks whether Groth16 ZK proofs can be verified on Stellar Soroban. It uses
the native BN254 (alt_bn128) pairing host functions from CAP-0074.

The ZKPerp design (private perps with trusted keepers) is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

- `contracts/zk-verifier/src/lib.rs`: Groth16 verifier contract (`init(vk)`, `verify(proof, public_inputs)`)
- `contracts/zk-verifier/src/test.rs`: makes a real proof with arkworks and checks it in the Soroban host
- `contracts/musdc-faucet`: makes mUSDC (mock USDC on a Stellar Asset Contract) freely mintable by anyone. See `docs/2_Mock USDC.md`
- `contracts/zkperp-vault`: GMX-style LP vault and trading (deposit mUSDC, get zLP shares; open private long/short positions; 2-of-3 signed Chainlink price; shielded collateral notes; closing; liquidation by keepers; treasury fees; borrow fee; stop loss / take profit; limit orders). See `docs/3_create_LP_vault.md`, `docs/4_open_position.md`
- `crates/zkperp-poseidon`: circomlib-compatible Poseidon (1, 2, 4 inputs) on the CAP-0075 host function, plus the Merkle zero hashes. Regenerate constants with `cd crates/zkperp-poseidon/gen && npm install && npm run gen`
- `crates/groth16`: Groth16/BN254 verification (MSM) used by the vault
- `contracts/poseidon`, `contracts/zk-verifier`: contract wrappers of those two libraries, with the circomlibjs and arkworks tests
- `frontend/`: the browser app (Public, Trade, Portfolio, Liquidity, Faucet), modelled on zkperp-midnight's; proves in the browser with the shared `circuits/lib`. `cd frontend && npm install && npm run dev`. See `docs/16_frontend.md`; your records are also kept encrypted on chain (memo board) so the same wallet + password works on any computer (`docs/17_records_on_chain.md`)
- `circuits/`: Circom circuits (open, notes, close, liquidation, merge, trigger orders, limit orders), trusted setup, client scripts, and the backend services (`circuits/services/`: keeper and oracle servers, pm2 ecosystem). Start here: `docs/0_learning_guide.md` (what was built, why, and what to learn from each step). Step-by-step docs: `docs/1_*.md` to `docs/17_records_on_chain.md`

The test circuit: the prover knows secret `a, b` with `a*b == product` and `a+b == sum`, where `product` and `sum` are public.

Points use the Ethereum-compatible encoding: G1 = `X||Y` (64 bytes), G2 = `X.c1||X.c0||Y.c1||Y.c0`
(128 bytes), all big-endian. Keys and proofs from circom/snarkjs (bn128) or arkworks work with this encoding.

## Run

```sh
cargo test -- --nocapture     # prints the CPU/memory cost of one verify
stellar contract build        # -> target/wasm32v1-none/release/zk_verifier.wasm
```

### Frontend

```sh
cd frontend
npm install
npm run dev                   # starts the Vite dev server (default: http://localhost:5173)
```

### Backend services (keeper + oracle)

```sh
cd circuits/services
pm2 start ecosystem.config.cjs  # starts keeper and oracle servers via pm2
pm2 logs                        # tail logs
pm2 stop all                    # stop all services
```
