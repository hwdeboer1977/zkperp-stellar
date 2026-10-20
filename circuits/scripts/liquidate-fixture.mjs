// Real proofs for the vault's liquidation tests:
//   node scripts/liquidate-fixture.mjs ../contracts/zkperp-vault/src/fixtures/liquidate.json
// Fresh vault: deposit 1,000 note (leaf 0) -> private 10x long 4,000 / 400 at
// P1 (position leaf 1, change leaf 2) -> price -8% to P2 -> keeper liquidates
// (owner's payout note leaf 3, treasury fee note leaf 4).
import fs from "node:fs";
import { newKeeperKey, decryptNote } from "../lib/keeper.mjs";
import { newNote, ownerHashOf } from "../lib/notes.mjs";
import { Tree } from "../lib/tree.mjs";
import { proveOpenPrivate } from "../lib/private.mjs";
import { proveLiquidation } from "../lib/liquidate.mjs";
import { vkeyToSoroban } from "../lib/encoding.mjs";

const U = 10_000_000n;
const ownerSecret = 1618033n, treasurySecret = 271828n;
const T0 = 1_792_000_000n, P1 = 81_921n * U, P2 = 75_367_3200000n; // -8%
const keeper = await newKeeperKey();
const note = { ...(await newNote(ownerSecret, 1_000n * U)), leafIndex: 0 };
const open = await proveOpenPrivate({ tree: await Tree.fromLeaves([note.commitment]), note, ownerSecret, isLong: true,
  size: 4_000n * U, collateral: 400n * U, entryPrice: P1, openTime: T0, feeBps: 10, keeperPk: keeper.pk });
// The keeper's view: decrypt the keeper note, exactly as the keeper service does.
const pos = await decryptNote(keeper.sk, [open.soroban.noteR.x, open.soroban.noteR.y], open.soroban.note);
const tree = await Tree.fromLeaves([note.commitment, BigInt(open.soroban.commitment), BigInt(open.soroban.change)]);
const liq = await proveLiquidation({ tree, pos, leafIndex: 1, exitPrice: P2, liqTime: T0 + 590n, feeBps: 10,
  treasuryOwner: await ownerHashOf(treasurySecret), maintenanceBps: 250, liqFeeBps: 50, borrowRate: 27_778 });

const vk = (n) => vkeyToSoroban(JSON.parse(fs.readFileSync(new URL(`../keys/${n}.vkey.json`, import.meta.url))));
const d = (x) => BigInt(x).toString();
const s = open.soroban, l = liq.soroban;
fs.writeFileSync(process.argv[2], JSON.stringify({
  keeper_pk: keeper.pk.map(d), treasury_owner: d(await ownerHashOf(treasurySecret)), borrow_rate: 27778,
  open_private_vk: vk("open_private"), withdraw_vk: vk("withdraw_note"), close_vk: vk("close_position"), liquidate_vk: vk("liquidate_position"),
  t0: d(T0), p1: d(P1), p2: d(P2),
  deposit: { amount: d(note.amount), inner: d(note.inner) },
  open: { root: d(s.root), nullifier: d(s.nullifier), commitment: d(s.commitment), change: d(s.change),
    note_r: [d(s.noteR.x), d(s.noteR.y)], note: s.note.map(d), proof: s.proof },
  liquidate: { root: d(l.root), nullifier: d(l.nullifier), payout: d(l.payout), fee: d(l.fee), pool_in: d(l.poolIn),
    liq_time: d(T0 + 590n), proof: l.proof, back: liq.settlement.back.toString(), fees: liq.settlement.fees.toString() },
}, null, 2) + "\n");
console.log(`liquidation fixture written: pool_in ${Number(liq.settlement.poolIn) / 1e7}, back to owner ${Number(liq.settlement.back) / 1e7}, fees ${Number(liq.settlement.fees) / 1e7}`);
process.exit(0);
