// Real proofs for the vault's treasury tests:
//   node scripts/treasury-fixture.mjs ../contracts/zkperp-vault/src/fixtures/treasury.json
// A vault (at a fixed address, registered there by the test) holds two notes
// of the treasury (30 and 12, leaves 0 and 1, deposited as stand-ins for fee
// notes); merge them (leaf 2, 42) and collect the 42 into the vault (change 0, leaf 3).
import fs from "node:fs";
import { newNote, recipientField } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveMerge, proveWithdraw } from "../lib/private.mjs";
import { vkeyToSoroban } from "../lib/encoding.mjs";

const U = 10_000_000n, treasury = 271828n;
const vault = "CDNKP3FFJWU5H46Y6FBVHELTUPQLWEQ2GOU4GMOCIM46AM3GEFSC33F2";
const a = { ...(await newNote(treasury, 30n * U)), leafIndex: 0 };
const b = { ...(await newNote(treasury, 12n * U)), leafIndex: 1 };
const t0 = await Tree.fromLeaves([a.commitment, b.commitment]);
const m = await proveMerge({ tree: t0, a, b, ownerSecret: treasury });
const merged = { ...m.merged, leafIndex: 2 };
const t1 = await Tree.fromLeaves([a.commitment, b.commitment, BigInt(merged.commitment)]);
const c = await proveWithdraw({ tree: t1, note: merged, ownerSecret: treasury, amount: 42n * U, recipient: recipientField(vault) });
const vk = (n) => vkeyToSoroban(JSON.parse(fs.readFileSync(new URL(`../keys/${n}.vkey.json`, import.meta.url))));
const d = (x) => BigInt(x).toString();
fs.writeFileSync(process.argv[2], JSON.stringify({
  vault, merge_vk: vk("merge_notes"), withdraw_vk: vk("withdraw_note"), open_private_vk: vk("open_private"),
  notes: [{ amount: d(a.amount), inner: d(a.inner) }, { amount: d(b.amount), inner: d(b.inner) }],
  merge: { root: d(m.soroban.root), nullifier_a: m.soroban.nullifierA, nullifier_b: m.soroban.nullifierB, merged: m.soroban.merged, proof: m.soroban.proof },
  collect: { root: d(c.soroban.root), nullifier: c.soroban.nullifier, amount: d(42n * U), change: c.soroban.change, proof: c.soroban.proof },
}, null, 2) + "\n");
console.log("treasury fixture written");
process.exit(0);
