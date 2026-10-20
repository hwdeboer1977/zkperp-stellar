// Oracle signing: the bytes a signer signs must equal what the vault
// verifies, sha256(xdr(("zkp_price", vault, round, price, updated_at))).
import { Address, Keypair, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";

const sym = (s) => xdr.ScVal.scvSymbol(s);

export function priceDigest(vault, round, price, updatedAt) {
  const v = xdr.ScVal.scvVec([
    sym("zkp_price"),
    Address.fromString(vault).toScVal(),
    nativeToScVal(BigInt(round), { type: "u128" }),
    nativeToScVal(BigInt(price), { type: "i128" }),
    nativeToScVal(BigInt(updatedAt), { type: "u64" }),
  ]);
  return Buffer.from(hash(v.toXDR()));
}

export function rotationDigest(vault, epoch, slot, keyHex) {
  const v = xdr.ScVal.scvVec([
    sym("zkp_rotat"),
    Address.fromString(vault).toScVal(),
    nativeToScVal(BigInt(epoch), { type: "u64" }),
    nativeToScVal(Number(slot), { type: "u32" }),
    xdr.ScVal.scvBytes(Buffer.from(keyHex, "hex")),
  ]);
  return Buffer.from(hash(v.toXDR()));
}

/** ed25519 signature (hex) by a Stellar secret key (S...). */
export const sign = (secret, digest) => Buffer.from(Keypair.fromSecret(secret).sign(digest)).toString("hex");

/** A Stellar account's ed25519 public key as 32-byte hex. */
export const rawKey = (publicKey) => Buffer.from(Keypair.fromPublicKey(publicKey).rawPublicKey()).toString("hex");

/** Chainlink 8-decimal answer -> the vault's 7 decimals (rounded down). */
export const toVaultPrice = (answer) => BigInt(answer) / 10n;
