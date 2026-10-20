// Shielded notes (step 6): commitments, owner secrets, recipient binding.
//   inner      = Poseidon(ownerHash, salt)
//   commitment = Poseidon(amount, inner)
//   nullifier  = Poseidon(salt, leafIndex)
import { Address, hash } from "@stellar/stellar-sdk";
import { crypto, randomScalar } from "./keeper.mjs";

const sha256 = (b) => Buffer.from(hash(Buffer.from(b)));

/**
 * The trader's note/position owner secret, derived from their Stellar secret
 * (<ROLE>_SECRET in .env), so no extra secret has to be stored. 248 bits, so
 * it is a valid field element.
 */
export const ownerSecretFor = (stellarSecret) =>
  BigInt("0x" + sha256(Buffer.from("zkperp-owner:" + stellarSecret)).toString("hex")) >> 8n;

export async function ownerHashOf(ownerSecret) {
  const { poseidon, F } = await crypto();
  return F.toObject(poseidon([BigInt(ownerSecret)]));
}

export async function noteInner(ownerHash, salt) {
  const { poseidon, F } = await crypto();
  return F.toObject(poseidon([BigInt(ownerHash), BigInt(salt)]));
}

export async function noteCommitment(amount, inner) {
  const { poseidon, F } = await crypto();
  return F.toObject(poseidon([BigInt(amount), BigInt(inner)]));
}

export async function nullifierOf(salt, leafIndex) {
  const { poseidon, F } = await crypto();
  return F.toObject(poseidon([BigInt(salt), BigInt(leafIndex)]));
}

/** A new note for `ownerSecret`: random salt, its inner hash and commitment. */
export async function newNote(ownerSecret, amount) {
  const salt = randomScalar(248);
  const inner = await noteInner(await ownerHashOf(ownerSecret), salt);
  return { amount: BigInt(amount), salt, inner, commitment: await noteCommitment(amount, inner) };
}

/**
 * The recipient as a field element: the first 31 bytes of
 * sha256(xdr(ScVal::Address)). Must match `recipient_field` in the vault.
 */
export const recipientField = (address) =>
  BigInt("0x" + sha256(Address.fromString(address).toScVal().toXDR()).subarray(0, 31).toString("hex"));
