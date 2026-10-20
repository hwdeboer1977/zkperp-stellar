// Keeper view key (BabyJubJub) and keeper-note decryption.
import { buildBabyjub, buildPoseidon } from "circomlibjs";

let bj, poseidon;
export async function crypto() {
  bj ??= await buildBabyjub();
  poseidon ??= await buildPoseidon();
  return { bj, poseidon, F: bj.F };
}

export const randomScalar = (bits) => {
  const buf = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const x = BigInt("0x" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")) & ((1n << BigInt(bits)) - 1n);
  return x === 0n ? 1n : x;
};

/** New keeper view keypair: sk < subgroup order, pk = sk * Base8. */
export async function newKeeperKey() {
  const { bj, F } = await crypto();
  const sk = randomScalar(256) % bj.subOrder;
  const pk = bj.mulPointEscalar(bj.Base8, sk);
  return { sk: sk.toString(), pk: [F.toObject(pk[0]).toString(), F.toObject(pk[1]).toString()] };
}

export const NOTE_FIELDS = ["isLong", "size", "collateral", "entryPrice", "openTime", "openFee", "ownerHash", "salt"];

/** Decrypts a keeper note (R, E[n]) with the keeper's sk; `names` labels the fields (default: a position). */
export async function decryptNote(sk, noteR, note, names = NOTE_FIELDS) {
  const { bj, poseidon, F } = await crypto();
  const R = [F.e(BigInt(noteR[0])), F.e(BigInt(noteR[1]))];
  const shared = bj.mulPointEscalar(R, BigInt(sk));
  const p = bj.p;
  const out = {};
  names.forEach((name, i) => {
    const pad = F.toObject(poseidon([shared[0], i]));
    out[name] = (((BigInt(note[i]) - pad) % p) + p) % p;
  });
  return out;
}

/** Recomputes a position commitment from its fields. */
export async function positionCommitment(pos) {
  const { poseidon, F } = await crypto();
  return F.toObject(poseidon(NOTE_FIELDS.map((k) => BigInt(pos[k]))));
}
