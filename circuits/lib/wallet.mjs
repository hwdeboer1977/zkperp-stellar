// A trader's private state for shielded collateral: notes in
// .zkperp/notes/<vault>-<leaf>.json (gitignored, mode 600). The owner secret
// is not stored: it is derived from <ROLE>_SECRET in .env.
import fs from "node:fs";
import { ROOT } from "./stellar.mjs";

const dir = ROOT + ".zkperp/notes";
const file = (vault, leaf) => `${dir}/${vault}-${leaf}.json`;

export function saveNote(vault, note) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rec = { vault, ...note, amount: String(note.amount), salt: String(note.salt), inner: note.inner && String(note.inner), commitment: String(note.commitment) };
  fs.writeFileSync(file(vault, note.leafIndex), JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
}

export function markSpent(vault, leafIndex, by) {
  const f = file(vault, leafIndex);
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...rec, spent: by }, null, 2) + "\n", { mode: 0o600 });
}

/** Unspent notes of `owner` (an address) on `vault`, smallest first. */
export function notesOf(vault, owner, { includeSpent = false } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(vault + "-"))
    .map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")))
    .filter((n) => n.owner === owner && (includeSpent || !n.spent))
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
}

export function savePosition(vault, leaf, record) {
  const d = ROOT + ".zkperp/positions";
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${d}/${vault}-${leaf}.json`, JSON.stringify({ vault, leafIndex: leaf, ...record }, null, 2) + "\n", { mode: 0o600 });
}
