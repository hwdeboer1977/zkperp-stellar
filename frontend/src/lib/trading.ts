// Every trader action: prove in the browser, submit (wallet for public steps,
// relayer for private ones), record the result in your encrypted store.
import type { Config } from "./config";
import { read, write, type Signer } from "./chain";
import { relay } from "./relay";
import type { PositionKey } from "./positionKey";
import { updateRecords, type NoteRec, type PositionRec, type Records } from "./store";
import * as zk from "./zk";

export type Step = (label: string) => void;
type Pos = PositionRec & { ownerHash?: string };
const now = () => BigInt(Math.floor(Date.now() / 1000) - 20); // the ledger clock must not be earlier

export async function fetchTree(c: Config, vault: string) {
  const count = Number(await read<number>(c, vault, "position_count"));
  const leaves: bigint[] = [];
  for (let start = 0; start < count; start += 100) leaves.push(...(await read<bigint[]>(c, vault, "leaves", { start, count: Math.min(100, count - start) })));
  const tree = await zk.Tree.fromLeaves(leaves);
  if (!(await read<boolean>(c, vault, "is_known_root", { root: tree.root }))) throw new Error("The rebuilt commitment tree doesn't match the vault yet; try again in a few seconds.");
  return tree;
}

const unspentNotes = (r: Records) => r.notes.filter((n) => !n.spent).sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
export const pickNote = (r: Records, amount: bigint) => unspentNotes(r).find((n) => BigInt(n.amount) >= amount);
export const noteBalance = (r: Records) => unspentNotes(r).reduce((a, n) => a + BigInt(n.amount), 0n);

/** Shields `amount` from the wallet into a private note (public: amount and account). */
export async function depositNote(c: Config, vault: string, wallet: { address: string; sign: Signer }, key: PositionKey, amount: bigint, step: Step) {
  step("Create the note");
  const note = await zk.newNote(key.ownerSecret, amount);
  step("Wallet signs the deposit");
  const leafIndex = Number(await write(c, vault, wallet.address, wallet.sign, "deposit_note", { from: wallet.address, amount, inner: note.inner }));
  await updateRecords(vault, key, (r) => r.notes.push({ leafIndex, amount: amount.toString(), salt: note.salt.toString(), inner: note.inner.toString(), commitment: note.commitment.toString(), origin: "deposit" }));
  return leafIndex;
}

/** Opens a long or short from a private note, via the relayer. */
export async function openPrivate(c: Config, vault: string, key: PositionKey, r: Records, o: { isLong: boolean; size: bigint; collateral: bigint }, step: Step) {
  const note = pickNote(r, o.collateral);
  if (!note) throw new Error("No single private note covers this collateral: deposit or merge first.");
  step("Read the commitment tree and the mark price");
  const [tree, mark, config] = await Promise.all([fetchTree(c, vault), read<{ price: bigint }>(c, vault, "mark_price"), read<{ fee_bps: number; keeper_key: { x: bigint; y: bigint } }>(c, vault, "perp_config")]);
  const openTime = now();
  step("Prove the open in this browser");
  const p = await zk.proveOpenPrivate({ tree, note, ownerSecret: key.ownerSecret, isLong: o.isLong, size: o.size, collateral: o.collateral,
    entryPrice: mark.price, openTime, feeBps: config.fee_bps, keeperPk: [config.keeper_key.x, config.keeper_key.y] });
  step("Relayer submits it");
  const s = p.soroban;
  const leaf = Number(await relay(vault, "open_position_private", { root: s.root.toString(), nullifier: s.nullifier, commitment: s.commitment, change: s.change,
    note_r: s.noteR, note: s.note, open_time: openTime.toString(), proof: s.proof }));
  await updateRecords(vault, key, (x) => {
    x.notes.find((n) => n.leafIndex === note.leafIndex)!.spent = `open #${leaf}`;
    x.positions.push({ leafIndex: leaf, ...p.position, isLong: o.isLong, openedAt: new Date().toISOString() });
    x.notes.push({ leafIndex: leaf + 1, amount: p.change.amount, salt: p.change.salt, inner: p.change.inner, commitment: p.change.commitment, origin: `change of open #${leaf}` });
  });
  return { leaf, entry: mark.price };
}

/** Closes your position at the mark price; the payout becomes a note. */
export async function closePosition(c: Config, vault: string, key: PositionKey, pos: PositionRec, step: Step) {
  step("Read the tree, price and settlement parameters");
  const [tree, mark, config, maxPayout, treasury, borrowRate] = await Promise.all([fetchTree(c, vault), read<{ price: bigint }>(c, vault, "mark_price"),
    read<{ fee_bps: number }>(c, vault, "perp_config"), read<bigint>(c, vault, "max_payout"), read<bigint>(c, vault, "treasury_owner"), read<number>(c, vault, "borrow_rate")]);
  const closeTime = now();
  step("Prove the close in this browser");
  const p = await zk.proveClose({ tree, pos, leafIndex: pos.leafIndex, ownerSecret: key.ownerSecret, payoutOwnerSecret: key.ownerSecret,
    exitPrice: mark.price, closeTime, feeBps: config.fee_bps, maxPayout, treasuryOwner: treasury, borrowRate });
  step("Relayer submits it");
  const s = p.soroban;
  const leaf = Number(await relay(vault, "close_position", { root: s.root.toString(), nullifier: s.nullifier, payout: s.payout, fee: s.fee,
    pool_in: s.poolIn, pool_out: s.poolOut, close_time: closeTime.toString(), proof: s.proof }));
  const st = p.settlement;
  await updateRecords(vault, key, (x) => {
    x.notes.push({ leafIndex: leaf, amount: st.payout.toString(), salt: p.payoutNote.salt, inner: p.payoutNote.inner, commitment: p.payoutNote.commitment, origin: `close #${pos.leafIndex}` });
    const rec = x.positions.find((q) => q.leafIndex === pos.leafIndex)!;
    rec.closed = { how: "closed", exitPrice: mark.price.toString(), payout: st.payout.toString(), pnl: ((st.isProfit ? 1n : -1n) * st.pnl).toString(), at: new Date().toISOString() };
  });
  return p.settlement;
}

/** Stop loss (kind 0) or take profit (kind 1) on your position; cancel with action 2. */
export async function orderAuth(c: Config, vault: string, key: PositionKey, pos: PositionRec, kind: "0" | "1", trigger: bigint, orderSalt: bigint, action: 1 | 2, step: Step) {
  step("Read the tree");
  const [tree, config] = await Promise.all([fetchTree(c, vault), read<{ keeper_key: { x: bigint; y: bigint } }>(c, vault, "perp_config")]);
  step(action === 1 ? "Prove the order (sealed to the keepers)" : "Prove the cancellation");
  const p = await zk.proveOrderAuth({ tree, pos, leafIndex: pos.leafIndex, ownerSecret: key.ownerSecret, kind, trigger, orderSalt, action,
    keeperPk: [config.keeper_key.x, config.keeper_key.y] });
  step("Relayer submits it");
  const s = p.soroban;
  await relay(vault, action === 1 ? "place_order" : "cancel_order", { root: s.root.toString(), order_id: s.orderId, note_r: s.noteR, note: s.note, proof: s.proof });
  return s.orderId as string;
}

export async function placeOrder(c: Config, vault: string, key: PositionKey, pos: PositionRec, kind: "0" | "1", trigger: bigint, step: Step) {
  const orderSalt = zk.newOrderSalt();
  const orderId = await orderAuth(c, vault, key, pos, kind, trigger, orderSalt, 1, step);
  await updateRecords(vault, key, (x) => x.orders.push({ orderId, leaf: pos.leafIndex, kind, trigger: trigger.toString(), orderSalt: orderSalt.toString() }));
}

export async function cancelOrder(c: Config, vault: string, key: PositionKey, pos: PositionRec, o: { orderId: string; kind: "0" | "1"; trigger: string; orderSalt: string }, step: Step) {
  await orderAuth(c, vault, key, pos, o.kind, BigInt(o.trigger), BigInt(o.orderSalt), 2, step);
  await updateRecords(vault, key, (x) => { x.orders.find((q) => q.orderId === o.orderId)!.done = "cancelled"; });
}

/** Limit order: escrow collateral from a note. */
export async function placeLimit(c: Config, vault: string, key: PositionKey, r: Records, o: { isLong: boolean; size: bigint; collateral: bigint; limitPrice: bigint }, step: Step) {
  const note = pickNote(r, o.collateral);
  if (!note) throw new Error("No single private note covers this collateral: deposit or merge first.");
  step("Read the commitment tree");
  const [tree, config] = await Promise.all([fetchTree(c, vault), read<{ keeper_key: { x: bigint; y: bigint } }>(c, vault, "perp_config")]);
  step("Prove the limit order (sealed to the keepers)");
  const p = await zk.provePlaceLimit({ tree, note, ownerSecret: key.ownerSecret, ...o, keeperPk: [config.keeper_key.x, config.keeper_key.y] });
  step("Relayer submits it");
  const s = p.soroban;
  const changeLeaf = Number(await relay(vault, "place_limit", { root: s.root.toString(), nullifier: s.nullifier, order: s.order, change: s.change, note_r: s.noteR, note: s.note, proof: s.proof }));
  await updateRecords(vault, key, (x) => {
    x.notes.find((n) => n.leafIndex === note.leafIndex)!.spent = "limit order";
    x.notes.push({ leafIndex: changeLeaf, amount: p.change.amount, salt: p.change.salt, inner: p.change.inner, commitment: p.change.commitment, origin: "change of limit order" });
    x.limits.push({ ...p.order, placedAt: new Date().toISOString() });
  });
}

export async function cancelLimit(c: Config, vault: string, key: PositionKey, order: Records["limits"][number], step: Step) {
  step("Prove the cancellation");
  const p = await zk.proveCancelLimit({ o: order, ownerSecret: key.ownerSecret });
  step("Relayer submits it");
  const leaf = Number(await relay(vault, "cancel_limit", { order: p.soroban.order, refund: p.soroban.refund, proof: p.soroban.proof }));
  await updateRecords(vault, key, (x) => {
    x.limits.find((l) => l.order === order.order)!.status = "cancelled";
    x.notes.push({ leafIndex: leaf, ...p.refund, origin: "limit order refund" });
  });
}

/** Unshields `amount` to a public address, via the relayer. */
export async function withdrawNote(c: Config, vault: string, key: PositionKey, r: Records, amount: bigint, recipient: string, step: Step) {
  const note = pickNote(r, amount);
  if (!note) throw new Error("No single private note covers this amount.");
  step("Read the commitment tree");
  const tree = await fetchTree(c, vault);
  step("Prove the withdrawal in this browser");
  const p = await zk.proveWithdraw({ tree, note, ownerSecret: key.ownerSecret, amount, recipient: zk.recipientField(recipient) });
  step("Relayer submits it");
  const leaf = Number(await relay(vault, "withdraw_note", { root: tree.root.toString(), nullifier: p.soroban.nullifier, amount: amount.toString(), recipient, change: p.soroban.change, proof: p.soroban.proof }));
  await updateRecords(vault, key, (x) => {
    x.notes.find((n) => n.leafIndex === note.leafIndex)!.spent = `withdraw ${amount}`;
    x.notes.push({ leafIndex: leaf, amount: p.change.amount, salt: p.change.salt, inner: p.change.inner, commitment: p.change.commitment, origin: "withdraw change" });
  });
}

/**
 * Finds what keepers did to your records: positions liquidated or closed by
 * your stop loss / take profit (recover their payout notes), and limit orders
 * filled (become positions).
 */
export async function sync(c: Config, vault: string, key: PositionKey, r: Records) {
  const ownerHash = await zk.ownerHashOf(key.ownerSecret);
  const changes: ((x: Records) => void)[] = [];
  const config = await read<{ fee_bps: number }>(c, vault, "perp_config");
  for (const l of r.limits.filter((l) => !l.status)) {
    const fill = await read<{ leaf_index: number; entry_price: bigint; open_time: bigint } | null>(c, vault, "limit_fill", { order: BigInt(l.order) });
    if (!fill) continue;
    const pos = await zk.filledPosition(l, fill.entry_price, fill.open_time, config.fee_bps);
    changes.push((x) => {
      x.limits.find((q) => q.order === l.order)!.status = "filled";
      x.limits.find((q) => q.order === l.order)!.fillLeaf = Number(fill.leaf_index);
      x.positions.push({ leafIndex: Number(fill.leaf_index), isLong: pos.isLong, size: pos.size.toString(), collateral: pos.collateral.toString(), entryPrice: pos.entryPrice.toString(),
        openTime: pos.openTime.toString(), openFee: pos.openFee.toString(), salt: pos.salt.toString(), commitment: pos.commitment.toString(), fromLimit: l.order, openedAt: new Date(Number(fill.open_time) * 1000).toISOString() });
    });
  }
  let lc: { maintenance_bps: number; liquidation_fee_bps: number } | null = null;
  for (const p of r.positions.filter((p) => !p.closed)) {
    const nullifier = await zk.nullifierOf(p.salt, p.leafIndex);
    if (!(await read<boolean>(c, vault, "is_spent", { nullifier }))) continue;
    const pos = { ...p, ownerHash: ownerHash.toString() } as Pos;
    const liq = await read<{ exit_price: bigint; payout_leaf: number; time: bigint } | null>(c, vault, "liquidation", { nullifier });
    const ex = liq ? null : await read<{ order_id: bigint; exit_price: bigint; payout_leaf: number; time: bigint; borrow_rate: number } | null>(c, vault, "order_execution", { nullifier });
    if (liq) {
      lc ??= await read(c, vault, "liquidation_config");
      const borrowRate = await read<number>(c, vault, "borrow_rate");
      const s = zk.settleLiquidation(pos, liq.exit_price, config.fee_bps, lc!.maintenance_bps, lc!.liquidation_fee_bps, { rate: borrowRate, time: liq.time });
      const note = await zk.liquidationPayoutNote(pos, s.back);
      changes.push((x) => {
        x.notes.push({ leafIndex: Number(liq.payout_leaf), ...note, origin: `liquidation of #${p.leafIndex}` });
        x.positions.find((q) => q.leafIndex === p.leafIndex)!.closed = { how: "liquidated", exitPrice: liq.exit_price.toString(), payout: s.back.toString(), pnl: (-s.pnl).toString(), at: new Date(Number(liq.time) * 1000).toISOString() };
      });
    } else if (ex) {
      const maxPayout = await read<bigint>(c, vault, "max_payout");
      const s = zk.settle(pos, ex.exit_price, config.fee_bps, maxPayout, { rate: ex.borrow_rate, time: ex.time });
      const note = await zk.orderPayoutNote(pos, s.payout);
      const kind = r.orders.find((o) => o.orderId === ex.order_id.toString())?.kind;
      changes.push((x) => {
        x.notes.push({ leafIndex: Number(ex.payout_leaf), ...note, origin: `order on #${p.leafIndex}` });
        x.positions.find((q) => q.leafIndex === p.leafIndex)!.closed = { how: kind === "1" ? "take profit" : "stop loss", exitPrice: ex.exit_price.toString(), payout: s.payout.toString(),
          pnl: ((s.isProfit ? 1n : -1n) * s.pnl).toString(), at: new Date(Number(ex.time) * 1000).toISOString() };
        const o = x.orders.find((q) => q.orderId === ex.order_id.toString());
        if (o) o.done = "executed";
      });
    } else {
      // Closed by you on another computer; the details arrive with its memo.
      changes.push((x) => { x.positions.find((q) => q.leafIndex === p.leafIndex)!.closed = { how: "closed", exitPrice: "", payout: "", at: new Date().toISOString() }; });
    }
  }
  if (changes.length) await updateRecords(vault, key, (x) => changes.forEach((f) => f(x)));
  return changes.length;
}

export type { NoteRec };
