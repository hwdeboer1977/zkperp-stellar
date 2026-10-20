#!/usr/bin/env bash
# Compiles a circuit and runs a SINGLE-PARTY Groth16 trusted setup.
# ⚠️ Hackathon only: whoever runs this knows the toxic waste and could forge
# proofs. Production needs a multi-party ceremony (ARCHITECTURE §15).
# Usage: scripts/setup.sh <circuit> [power]   (power: Powers of Tau 2^power, default 14)
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${1:?circuit name}
POWER=${2:-14}
SNARKJS="npx snarkjs"
mkdir -p build keys

circom "$NAME.circom" --r1cs --wasm --sym -o build

PTAU=build/pot${POWER}_final.ptau
if [ ! -f "$PTAU" ]; then
  $SNARKJS powersoftau new bn128 "$POWER" "build/pot${POWER}_0.ptau"
  $SNARKJS powersoftau contribute "build/pot${POWER}_0.ptau" "build/pot${POWER}_1.ptau" \
    --name="zkperp hackathon" -e="$(head -c 64 /dev/urandom | base64)"
  $SNARKJS powersoftau prepare phase2 "build/pot${POWER}_1.ptau" "$PTAU"
fi

$SNARKJS groth16 setup "build/$NAME.r1cs" "$PTAU" "build/${NAME}_0.zkey"
$SNARKJS zkey contribute "build/${NAME}_0.zkey" "keys/$NAME.zkey" \
  --name="zkperp hackathon" -e="$(head -c 64 /dev/urandom | base64)"
$SNARKJS zkey export verificationkey "keys/$NAME.zkey" "keys/$NAME.vkey.json"
cp "build/${NAME}_js/$NAME.wasm" "keys/$NAME.wasm"
echo "keys/$NAME.{zkey,vkey.json,wasm} written"
