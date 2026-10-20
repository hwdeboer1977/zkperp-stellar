import { useEffect, useRef, useState } from "react";
import type { Config } from "../lib/config";
import { usePoll, type VaultState } from "../lib/hooks";
import { tokenBalance } from "../lib/chain";
import { useWallet } from "../lib/wallet";
import { useKey } from "../lib/positionKey";
import { backupBlob, importBackup, useRecords, type PositionRec } from "../lib/store";
import { fmt, toUnits } from "../lib/format";
import { cancelLimit, cancelOrder, closePosition, depositNote, noteBalance, placeOrder, sync, withdrawNote } from "../lib/trading";
import { closeNow, liqPrice } from "../lib/positions";
import { NeedsWallet, Stat, useAction } from "../components/ui";
import { PositionKeyPanel } from "../components/PositionKey";

export default function PortfolioPage({ config, vault, state }: { config: Config; vault: string; state: VaultState | null }) {
  const w = useWallet();
  const key = useKey();
  const records = useRecords();
  const unlocked = !!key && key.account === w.address;
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const synced = useRef("");
  useEffect(() => {
    if (!unlocked || synced.current === key!.id + vault) return;
    synced.current = key!.id + vault;
    sync(config, vault, key!, records).then((n) => n && setSyncMsg(`Found ${n} update(s) made by keepers (fills, liquidations, executed orders).`)).catch((e) => setSyncMsg(`Sync failed: ${e.message}`));
  }, [unlocked, key, vault, config, records]);
  const open = records.positions.filter((p) => !p.closed), closed = records.positions.filter((p) => p.closed);
  const unreal = state ? open.reduce((a, p) => { const s = closeNow(p, state); return s ? a + (s.isProfit ? s.pnl : -s.pnl) : a; }, 0n) : 0n;
  const realised = closed.reduce((a, p) => a + BigInt(p.closed!.payout) - BigInt(p.collateral) - BigInt(p.openFee), 0n);
  return (
    <>
      <p className="eyebrow">Your positions</p>
      <h1>Portfolio</h1>
      <p className="lead">Your private notes and positions, encrypted under your position key, in this browser and on chain. The public sees commitments and nullifiers, not these rows. Connect the same wallet with the same password on any computer to see them there.</p>
      {!w.address ? <NeedsWallet what="see your portfolio" /> : <PositionKeyPanel />}
      {unlocked && (
        <>
          <div className="stats">
            <Stat label="Private balance" value={fmt(noteBalance(records))} unit="mUSDC" sub={`${records.notes.filter((n) => !n.spent).length} unspent notes`} />
            <Stat label="Open positions" value={open.length} sub={`${fmt(open.reduce((a, p) => a + BigInt(p.collateral), 0n))} mUSDC collateral at risk`} />
            <Stat label="Unrealised PnL" value={<span className={unreal >= 0n ? "good" : "bad"}>{unreal >= 0n ? "+" : "−"}{fmt(unreal < 0n ? -unreal : unreal)}</span>} sub="at the mark price, before fees" />
            <Stat label="Net realised PnL" value={<span className={realised >= 0n ? "good" : "bad"}>{realised >= 0n ? "+" : "−"}{fmt(realised < 0n ? -realised : realised)}</span>} sub={`paid out less posted, all fees in · ${closed.length} closed`} />
          </div>
          {syncMsg && <div className="banner ok">{syncMsg}</div>}
          <div className="grid-main">
            <div>
              <div className="card">
                <div className="card-head"><h2>Open positions <span className="muted">execution at the on-chain mark price</span></h2></div>
                {open.length === 0 ? <div className="muted small">No open positions.</div> :
                  <div className="pos-list">{open.map((p) => <PositionCard key={p.leafIndex} config={config} vault={vault} state={state} p={p} />)}</div>}
              </div>
              <LimitOrders config={config} vault={vault} />
              <History closed={closed} />
            </div>
            <div className="sticky">
              <Balance config={config} vault={vault} />
              <Backup vault={vault} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

function PositionCard({ config, vault, state, p }: { config: Config; vault: string; state: VaultState | null; p: PositionRec }) {
  const key = useKey()!;
  const records = useRecords();
  const act = useAction();
  const s = state ? closeNow(p, state) : null;
  const lp = state?.liq ? liqPrice({ ...p, size: BigInt(p.size), collateral: BigInt(p.collateral), entryPrice: BigInt(p.entryPrice) }, state.config.fee_bps, state.liq.maintenance_bps) : null;
  const orders = records.orders.filter((o) => o.leaf === p.leafIndex && !o.done);
  return (
    <div className={`pos-card ${p.isLong ? "" : "short"}`}>
      <div className="pos-head">
        <b>BTC/USD</b>
        <span className={`chip plain ${p.isLong ? "good" : "bad"}`}>{p.isLong ? "LONG" : "SHORT"} {(Number(p.size) / Number(p.collateral)).toFixed(1)}×</span>
        <span className="chip accent">private</span>
        {p.fromLimit && <span className="chip plain">limit</span>}
        <span className="when">#{p.leafIndex} · opened {new Date(p.openedAt).toLocaleString()}</span>
      </div>
      <div className="pos-grid">
        <div className="kv"><span>Size</span><b>{fmt(p.size)}</b></div>
        <div className="kv"><span>Collateral</span><b>{fmt(p.collateral)}</b></div>
        <div className="kv"><span>Entry</span><b>{fmt(p.entryPrice)}</b></div>
        <div className="kv"><span>Mark</span><b>{state?.mark ? fmt(state.mark.price) : "–"}</b></div>
        <div className="kv"><span>Liquidation</span><b className="warn-text">{lp ? `≈ ${fmt(lp, 0)}` : "–"}</b></div>
      </div>
      <div className="pos-foot">
        <div className="kv"><span>Unrealised PnL</span><span className={`pnl ${s?.isProfit ? "good" : "bad"}`}>{s ? `${s.isProfit ? "+" : "−"}${fmt(s.pnl)}` : "–"}</span></div>
        <div className="kv"><span>If closed now</span><b>{s ? `${fmt(s.payout)} back` : "–"}</b></div>
        <div className="kv"><span>Fees to close</span><b>{s ? fmt(s.closeFee + s.borrowFee) : "–"}</b></div>
        <button disabled={act.busy} onClick={() => act.run(async (step) => {
          const r = await closePosition(config, vault, key, p, step);
          return `Closed: ${r.isProfit ? "profit" : "loss"} ${fmt(r.pnl)}; ${fmt(r.payout)} back as a private note.`;
        })}>Close position</button>
      </div>
      <div className="pos-orders">
        {(["0", "1"] as const).map((kind) => <OrderLine key={kind} config={config} vault={vault} p={p} kind={kind} existing={orders.find((o) => o.kind === kind)} mark={state?.mark?.price} />)}
      </div>
      {act.view}
    </div>
  );
}

function OrderLine({ config, vault, p, kind, existing, mark }: { config: Config; vault: string; p: PositionRec; kind: "0" | "1"; existing?: { orderId: string; kind: "0" | "1"; trigger: string; orderSalt: string }; mark?: bigint }) {
  const key = useKey()!;
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState("");
  const act = useAction();
  const below = p.isLong !== (kind === "1"); // long SL / short TP fire at or below
  const trigger = (() => { try { return v ? toUnits(v) : 0n; } catch { return 0n; } })();
  const bad = trigger && mark ? (below ? trigger >= mark : trigger <= mark) : false;
  return (
    <div className="order-line">
      <span className="kind">{kind === "0" ? "Stop loss" : "Take profit"}</span>
      {existing && !edit ? <span className={kind === "0" ? "bad" : "good"}>${fmt(existing.trigger)}</span> : !edit && <span className="muted">none</span>}
      {edit && <input placeholder={below ? "below the price" : "above the price"} value={v} onChange={(e) => setV(e.target.value)} />}
      {!edit ? (
        <>
          <button className="small" disabled={act.busy} onClick={() => setEdit(true)}>{existing ? "Move" : "Set"}</button>
          {existing && <button className="small ghost" disabled={act.busy} onClick={() => act.run(async (step) => { await cancelOrder(config, vault, key, p, existing, step); return "Order cancelled."; })}>Cancel</button>}
        </>
      ) : (
        <>
          <button className="small" disabled={!trigger || bad || act.busy} onClick={() => act.run(async (step) => {
            if (existing) await cancelOrder(config, vault, key, p, existing, step);
            await placeOrder(config, vault, key, p, kind, trigger, step);
            setEdit(false); setV("");
            return `${kind === "0" ? "Stop loss" : "Take profit"} set at $${fmt(trigger)}. The level is sealed to the keepers; nobody else sees it.`;
          })}>Place</button>
          <button className="small ghost" onClick={() => setEdit(false)}>Back</button>
          {bad && <span className="small warn-text">Must be {below ? "below" : "above"} the current price.</span>}
        </>
      )}
      {act.view}
    </div>
  );
}

function LimitOrders({ config, vault }: { config: Config; vault: string }) {
  const key = useKey()!;
  const records = useRecords();
  const act = useAction();
  if (!records.limits.length) return null;
  return (
    <div className="card">
      <div className="card-head"><h2>Limit orders <span className="muted">filled by a keeper when the price gets there</span></h2></div>
      <div className="table-wrap"><table>
        <thead><tr><th></th><th>Limit</th><th>Size</th><th>Posted</th><th>Status</th><th>Placed</th><th></th></tr></thead>
        <tbody>{records.limits.map((l) => (
          <tr key={l.order}>
            <td className={`text ${l.isLong ? "long" : "short"}`}>{l.isLong ? "Long" : "Short"}</td>
            <td>{fmt(l.limitPrice)}</td><td>{fmt(l.size)}</td><td>{fmt(l.collateral)}</td>
            <td><span className={`chip ${l.status === "filled" ? "good" : l.status ? "plain" : "accent"}`}>{l.status === "filled" ? `filled → #${l.fillLeaf}` : l.status ?? "waiting"}</span></td>
            <td className="text small">{new Date(l.placedAt).toLocaleString()}</td>
            <td>{!l.status && <button className="small" disabled={act.busy} onClick={() => act.run(async (step) => { await cancelLimit(config, vault, key, l, step); return "Limit order cancelled; collateral back as a note."; })}>Cancel</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {act.view}
    </div>
  );
}

function History({ closed }: { closed: PositionRec[] }) {
  if (!closed.length) return null;
  return (
    <div className="card">
      <div className="card-head"><h2>History</h2></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Opened</th><th>Side</th><th>Size</th><th>Entry → Exit</th><th>Net PnL</th><th>Status</th></tr></thead>
        <tbody>{closed.slice().reverse().map((p) => {
          const known = p.closed!.payout !== ""; // closed on another computer, details still arriving
          const net = known ? BigInt(p.closed!.payout) - BigInt(p.collateral) - BigInt(p.openFee) : 0n;
          const how = p.closed!.how;
          return (
            <tr key={p.leafIndex}>
              <td className="text small">{new Date(p.openedAt).toLocaleString()}</td>
              <td className={`text ${p.isLong ? "long" : "short"}`}>{p.isLong ? "Long" : "Short"}{p.fromLimit ? " · limit" : ""}</td>
              <td>{fmt(p.size)}</td><td>{fmt(p.entryPrice, 0)} → {known ? fmt(p.closed!.exitPrice, 0) : "…"}</td>
              <td className={!known ? "muted" : net >= 0n ? "good" : "bad"}>{!known ? "…" : `${net >= 0n ? "+" : "−"}${fmt(net < 0n ? -net : net)}`}</td>
              <td><span className={`chip ${how === "liquidated" ? "bad" : how === "stop loss" ? "warn" : how === "take profit" ? "good" : "plain"}`}>{how}</span></td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </div>
  );
}

function Balance({ config, vault }: { config: Config; vault: string }) {
  const w = useWallet();
  const key = useKey()!;
  const records = useRecords();
  const [mode, setMode] = useState<"shield" | "unshield">("shield");
  const [amt, setAmt] = useState("");
  const [to, setTo] = useState("");
  const act = useAction();
  const units = (() => { try { return amt ? toUnits(amt) : 0n; } catch { return 0n; } })();
  const notes = records.notes.filter((n) => !n.spent);
  // Minted / unshielded mUSDC sits in the wallet (public) until it is shielded.
  const [wallet, , refreshWallet] = usePoll(w.address ? () => tokenBalance(config, w.address!).catch(() => 0n) : null, 10000, [w.address]);
  const privateTotal = notes.reduce((a, n) => a + BigInt(n.amount), 0n);
  const available = mode === "shield" ? wallet : privateTotal;
  return (
    <div className="card trade">
      <div className="card-head"><h2>Private balance</h2><span className="chip accent">notes</span></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Leaf</th><th>Amount</th><th>From</th></tr></thead>
        <tbody>{notes.map((n) => <tr key={n.leafIndex}><td>#{n.leafIndex}</td><td>{fmt(n.amount)}</td><td className="text small">{n.origin}</td></tr>)}
          {!notes.length && <tr><td colSpan={3} className="text muted">No private notes yet. Shield mUSDC below.</td></tr>}</tbody>
      </table></div>
      <div className="toggle">
        <button className={`long ${mode === "shield" ? "on" : ""}`} onClick={() => setMode("shield")}>Shield</button>
        <button className={`short ${mode === "unshield" ? "on" : ""}`} onClick={() => setMode("unshield")}>Unshield</button>
      </div>
      <label>{mode === "shield" ? "From your wallet into a private note" : "From a private note to a public address"}
        <div className="input-unit"><input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" /><span>mUSDC</span></div></label>
      <div className="row small" style={{ justifyContent: "space-between" }}>
        <span className="muted">{mode === "shield" ? "In your wallet (public)" : "Private balance"}: <b className="mono">{available == null ? "…" : fmt(available)}</b> mUSDC</span>
        <button className="ghost small" disabled={!available} onClick={() => setAmt(fmt(available!, 7).replace(/,/g, "").replace(/\.?0+$/, ""))}>Max</button>
      </div>
      {mode === "shield" && wallet === 0n && <span className="small muted">Nothing to shield yet: mint mUSDC on the Faucet page first.</span>}
      {mode === "unshield" && <label>Recipient (G… or C…)<input value={to} placeholder={w.address ?? ""} onChange={(e) => setTo(e.target.value)} /></label>}
      <span className="small muted">{mode === "shield" ? "Public: the amount and your account (a token transfer). From then on, which trade spends it is private." : "Public: the amount and the recipient. Not which note, not your account (the relayer submits it). Use a fresh address to stay unlinked."}</span>
      <button className="primary" disabled={!units || act.busy} onClick={() => act.run(async (step) => {
        if (mode === "shield") { const leaf = await depositNote(config, vault, { address: w.address!, sign: w.sign }, key, units, step); setAmt(""); refreshWallet(); return `Shielded ${amt} mUSDC into note #${leaf}.`; }
        await withdrawNote(config, vault, key, records, units, to || w.address!, step); setAmt("");
        return `Unshielded ${amt} mUSDC.`;
      })}>{mode === "shield" ? `Shield ${amt || 0} mUSDC` : `Unshield ${amt || 0} mUSDC`}</button>
      {act.view}
    </div>
  );
}

function Backup({ vault }: { vault: string }) {
  const key = useKey()!;
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <details className="card">
      <summary>Where your positions live <span className="muted">and backup</span></summary>
      <div className="inspect">
        <div><b>On chain</b><br />Commitments and nullifiers: public, but meaningless without your secrets.</div>
        <div><b>In this browser</b><br />Your notes and positions (salts, amounts), encrypted with your position key.</div>
        <div><b>On the memo board</b><br />The same records, encrypted, posted by the relayer (never your account). Any computer with your wallet and password finds and decrypts them; to anyone else they are random bytes.</div>
        <div><b>On another computer</b><br />Connect the same wallet, enter the same password: your notes, positions and orders appear within seconds. The backup file is an extra copy.</div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="small" onClick={async () => {
          const blob = new Blob([await backupBlob(key)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `zkperp-soroban-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
        }}>Download backup</button>
        <label className="small" style={{ flexDirection: "row", alignItems: "center" }}>Import
          <input type="file" accept="application/json" style={{ width: 200 }} onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try { await importBackup(vault, key, await f.text()); setMsg("Backup imported."); } catch { setMsg("That backup was made with another password or account."); }
          }} /></label>
      </div>
      {msg && <div className="small muted" style={{ marginTop: 8 }}>{msg}</div>}
    </details>
  );
}
