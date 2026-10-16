# soroban-zkperp

Checks whether Groth16 ZK proofs can be verified on Stellar Soroban. It uses
the native BN254 (alt_bn128) pairing host functions from CAP-0074.

The ZKPerp design (private perps with trusted keepers) is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

- `contracts/zk-verifier/src/lib.rs`: Groth16 verifier contract (`init(vk)`, `verify(proof, public_inputs)`)
- `contracts/zk-verifier/src/test.rs`: makes a real proof with arkworks and checks it in the Soroban host
- `contracts/poseidon`: circomlib-compatible Poseidon (1, 2, 4 inputs) on the CAP-0075 host function, tested against circomlibjs vectors. Regenerate constants with `cd contracts/poseidon/gen && npm install && npm run gen`

The test circuit: the prover knows secret `a, b` with `a*b == product` and `a+b == sum`, where `product` and `sum` are public.

Points use the Ethereum-compatible encoding: G1 = `X||Y` (64 bytes), G2 = `X.c1||X.c0||Y.c1||Y.c0`
(128 bytes), all big-endian. Keys and proofs from circom/snarkjs (bn128) or arkworks work with this encoding.

## Run

```sh
cargo test -- --nocapture     # prints the CPU/memory cost of one verify
stellar contract build        # -> target/wasm32v1-none/release/zk_verifier.wasm
```
