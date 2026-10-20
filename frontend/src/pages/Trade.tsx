import { useCallback, useMemo, useState } from "react";
import type { Config } from "../lib/config";
import { useNow, type VaultState } from "../lib/hooks";
import { useWallet } from "../lib/wallet";
import { useKey } from "../lib/positionKey";
import { useRecords } from "../lib/store";
import { fmt, toUnits, ago } from "../lib/format";
import { closePosition, noteBalance, openPrivate, placeLimit } from "../lib/trading";
import { ceilDiv, closeNow, liqPrice, sizeFor } from "../lib/positions";
import { CandleChart, INTERVALS, type Level } from "../components/CandleChart";
import { Coin, NeedsWallet, useAction } from "../components/ui";
import { PositionKeyPanel } from "../components/PositionKey";
import { Link } from "react-router-dom";

export default function TradePage({ config, vault, state }: { config: Config; vault: string; state: VaultState | null }) {
  const w = useWallet();
  const key = useKey();
  const records = useRecords();
  const now = useNow(1000);
  const [interval, setInterval] = useState(900);
  const [live, setLive] = useState<{ p: number; first: number } | null>(null);
  const onLive = useCallback((p: number, first: number) => setLive({ p, first }), []);
  const unlocked = !!w.address && key?.account === w.address;

  const mark = state?.mark ? Number(state.mark.price) / 1e7 : undefined;
  const age = state?.mark ? now - Number(state.mark.time) : 0;
  const maxAge = state ? Number(state.config.max_price_age) : 3900;
  const stale = age >= maxAge;
  const deviation = live && mark ? ((mark - live.p) / live.p) * 100 : 0;
  const open = records.positions.filter((p) => !p.closed);
  const levels: Level[] = useMemo(() => [
    ...records.orders.filter((o) => !o.done && open.some((p) => p.leafIndex === o.leaf)).map((o) => {
      const p = open.find((q) => q.leafIndex === o.leaf)!;
      return { price: Number(o.trigger) / 1e7, title: `${o.kind === "0" ? "SL" : "TP"} ${p.isLong ? "long" : "short"}`, color: o.kind === "0" ? "#f4566a" : "#2fd08a" };
    }),
    ...records.limits.filter((l) => !l.status).map((l) => ({ price: Number(l.limitPrice) / 1e7, title: `Limit ${l.isLong ? "long" : "short"}`, color: "#7d879c" })),
  ], [records, open]);

  return (
    <>
      <div className="grid-main">
        <div>
          <div className="card">
            <div className="market-head">
              <span className="row"><Coin /><span><b>BTC/USD</b><div className="small muted">Perpetual · mUSDC</div></span></span>
              <div className="kv"><span>Live market</span><b className="big">{live ? live.p.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "…"}</b></div>
              <div className="kv"><span>Change · chart</span><b className={live && live.p >= live.first ? "good" : "bad"}>{live ? `${(((live.p - live.first) / live.first) * 100).toFixed(2)}%` : "–"}</b></div>
              <div className="kv"><span>Execution price</span><b className="accent-text">{mark ? `$${mark.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "–"}</b></div>
              <div className="kv"><span>Deviation</span><b className={Math.abs(deviation) > 0.5 ? "warn-text" : ""}>{live && mark ? `${deviation.toFixed(2)}%` : "–"}</b></div>
              <div className="kv"><span>Oracle age</span><b>{state?.mark ? `${ago(age)} / ${Math.floor(maxAge / 60)}m` : "–"}</b></div>
            </div>
            <div className="chart-bar">
              <div className="intervals">{INTERVALS.map(([l, s]) => <button key={s} className={interval === s ? "on" : ""} onClick={() => setInterval(s)}>{l}</button>)}</div>
              <span className={`chip ${stale ? "bad" : age > maxAge * 0.85 ? "warn" : "good"}`}>{stale ? "Oracle stale · trading paused" : age > maxAge * 0.85 ? "Oracle price expiring" : "Oracle live"}</span>
              <span className="legend"><span className="swatch" /> execution price · candles: Coinbase BTC-USD</span>
            </div>
            {Math.abs(deviation) > 0.5 && <div className="banner warn">The execution price is {Math.abs(deviation).toFixed(2)}% {deviation < 0 ? "below" : "above"} the live market. Trades open and close at ${mark?.toLocaleString()}, not at the live price: the oracle follows Chainlink (0.5% moves or hourly).</div>}
            <CandleChart granularity={interval} execution={mark} levels={levels} onLive={onLive} />
          </div>
          <PositionsTable config={config} vault={vault} state={state} />
          <details className="card">
            <summary>Privacy inspector <span className="muted">who sees what, at each step of this trade</span></summary>
            <div className="inspect">
              <div><b>In your browser</b><br />Size, side, collateral, leverage, your owner secret and the salt. The proof is made here; nothing private leaves the page.</div>
              <div><b>Your wallet</b><br />Signs only public steps (faucet, shielding, LP). It never signs a trade, so your account doesn't appear in one.</div>
              <div><b>The relayer</b><br />Submits the proof and pays its fee. It sees what everyone sees, and can't change the trade: the proof binds every value.</div>
              <div><b>Everyone, on chain</b><br />A nullifier, a position commitment, a change note and a note sealed to the keepers; one more reserved slot. Longs and shorts look alike.</div>
              <div><b>The three keepers</b><br />Decrypt the sealed note: enough to liquidate, never your owner secret, so none can close for you.</div>
              <div><b>At close</b><br />A nullifier no one can link to this open, and the pool's change, which is the PnL. The fees go to a private treasury note.</div>
            </div>
          </details>
        </div>
        <div className="sticky">
          {!w.address ? <NeedsWallet what="trade" /> : <PositionKeyPanel compact />}
          <OrderForm config={config} vault={vault} state={state} unlocked={unlocked} stale={stale} />
        </div>
      </div>
    </>
  );
}

function PositionsTable({ config, vault, state }: { config: Config; vault: string; state: VaultState | null }) {
  const key = useKey();
  const records = useRecords();
  const act = useAction();
  const open = records.positions.filter((p) => !p.closed);
  if (!key) return null;
  return (
    <div className="card">
      <div className="card-head"><h2>Your private positions</h2><span className="chip accent">encrypted in this browser</span></div>
      {open.length === 0 ? <div className="muted small">No open positions. <Link to="/portfolio">Portfolio</Link> shows history and orders.</div> : (
        <div className="table-wrap"><table>
          <thead><tr><th></th><th>Size</th><th>Collateral</th><th>Entry</th><th>PnL now</th><th>You receive</th><th></th></tr></thead>
          <tbody>{open.map((p) => {
            const s = state ? closeNow(p, state) : null;
            const lp = state?.liq ? liqPrice({ ...p, size: BigInt(p.size), collateral: BigInt(p.collateral), entryPrice: BigInt(p.entryPrice) }, state.config.fee_bps, state.liq.maintenance_bps) : null;
            return (
              <tr key={p.leafIndex}>
                <td className={`text ${p.isLong ? "long" : "short"}`}>{p.isLong ? "Long" : "Short"} {(Number(p.size) / Number(p.collateral)).toFixed(1)}×</td>
                <td>{fmt(p.size)}</td><td>{fmt(p.collateral)}</td>
                <td>{fmt(p.entryPrice)}{lp && <div className="small muted">liq. ≈ {fmt(lp, 0)}</div>}</td>
                <td className={s?.isProfit ? "good" : "bad"}>{s ? `${s.isProfit ? "+" : "−"}${fmt(s.pnl)}` : "–"}{s && s.poolOut === state?.maxPayout && <div className="small">capped</div>}</td>
                <td>{s ? fmt(s.payout) : "–"}</td>
                <td><button className="small" disabled={act.busy} onClick={() => act.run(async (step) => {
                  const r = await closePosition(config, vault, key, p, step);
                  return `Closed #${p.leafIndex}: ${r.isProfit ? "profit" : "loss"} ${fmt(r.pnl)}, ${fmt(r.payout)} back as a private note.`;
                })}>Close</button></td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {act.view}
    </div>
  );
}

function OrderForm({ config, vault, state, unlocked, stale }: { config: Config; vault: string; state: VaultState | null; unlocked: boolean; stale: boolean }) {
  const key = useKey();
  const records = useRecords();
  const [mode, setMode] = useState<"market" | "limit">("market");
  const [side, setSide] = useState<"long" | "short">("long");
  const [coll, setColl] = useState("100");
  const [lev, setLev] = useState(5);
  const [limit, setLimit] = useState("");
  const [confirming, setConfirming] = useState(false);
  const act = useAction();
  const feeBps = state?.config.fee_bps ?? 10;
  const balance = noteBalance(records);
  const biggest = records.notes.filter((n) => !n.spent).reduce((m, n) => (BigInt(n.amount) > m ? BigInt(n.amount) : m), 0n);
  const collateral = (() => { try { return toUnits(coll || "0"); } catch { return 0n; } })();
  const size = sizeFor(collateral, lev, feeBps);
  const openFee = ceilDiv(size * BigInt(feeBps), 10_000n);
  const net = collateral - openFee;
  const entry = mode === "limit" && limit ? toUnits(limit) : state?.mark?.price ?? 0n;
  const isLong = side === "long";
  const liq = state?.liq && size > 0n && entry > 0n ? liqPrice({ isLong, size, collateral: net, entryPrice: entry }, feeBps, state.liq.maintenance_bps) : null;
  const borrowPerHour = state ? ceilDiv(size * BigInt(state.borrowRate) * 3600n, 1_000_000_000_000n) : 0n;
  const capMove = state && size > 0n ? (Number(state.maxPayout) / Number(size)) * 100 : 0;
  const problem = !state ? "Reading the vault…"
    : mode === "market" && stale ? "Trading is paused until the oracle publishes a fresh price. A limit order can still be placed."
    : collateral <= 0n ? "Enter the collateral to post."
    : mode === "limit" && !limit ? "Enter the limit price."
    : collateral > biggest ? (balance >= collateral ? "Your private balance is split over several notes; no single note covers this. Use less, or shield one larger note." : `Your private balance is ${fmt(balance)} mUSDC. Shield more on the Portfolio page.`)
    : net <= 0n || size < net ? "Collateral too small for the fee."
    : mode === "market" && state.pool <= BigInt(state.live + 1) * state.maxPayout ? "The pool has no room for another position right now."
    : !unlocked ? "Unlock your position key above to trade." : null;
  const submit = () => act.run(async (step) => {
    setConfirming(false);
    if (mode === "market") {
      const r = await openPrivate(config, vault, key!, records, { isLong, size, collateral }, step);
      return `Position #${r.leaf} opened at $${fmt(r.entry)}: ${side} ${fmt(size)} mUSDC. Only its commitment is on chain; set a stop loss or take profit in the Portfolio.`;
    }
    await placeLimit(config, vault, key!, records, { isLong, size, collateral, limitPrice: toUnits(limit) }, step);
    return `Limit ${side} placed at $${limit}. A keeper opens it when the execution price gets there; the level is sealed to the keepers.`;
  });
  return (
    <div className="card trade">
      <div className="mode-tabs">
        <button className={mode === "market" ? "on" : ""} onClick={() => setMode("market")}>Market</button>
        <button className={mode === "limit" ? "on" : ""} onClick={() => { setMode("limit"); if (!limit && state?.mark) setLimit((Number(state.mark.price) / 1e7).toFixed(0)); }}>Limit</button>
      </div>
      <div className="toggle">
        <button className={`long ${side === "long" ? "on" : ""}`} onClick={() => setSide("long")}>Long</button>
        <button className={`short ${side === "short" ? "on" : ""}`} onClick={() => setSide("short")}>Short</button>
      </div>
      {mode === "limit" && (
        <label><span className="label-row">Limit price<span className="muted">mark ${state?.mark ? fmt(state.mark.price, 0) : "…"}</span></span>
          <div className="input-unit"><input value={limit} onChange={(e) => setLimit(e.target.value)} /><span>USD</span></div>
          <span className="small muted">Opens when the execution price is at or {isLong ? "below" : "above"} this. The level is private.</span></label>
      )}
      <label><span className="label-row">Collateral<span className="muted">private {fmt(balance)} mUSDC</span></span>
        <div className="input-unit"><input value={coll} onChange={(e) => setColl(e.target.value)} /><span>mUSDC</span></div></label>
      <div className="quick">{[0.25, 0.5, 0.75, 1].map((f) => <button key={f} onClick={() => setColl((Number(biggest) * f / 1e7).toFixed(2))}>{f === 1 ? "Max" : `${f * 100}%`}</button>)}</div>
      <label><span className="label-row">Leverage<span className="muted">{lev}×</span></span>
        <input type="range" min={1} max={20} step={0.5} value={lev} onChange={(e) => setLev(Number(e.target.value))} />
        <div className="ticks"><span>1×</span><span>10×</span><span>20×</span></div></label>
      <dl className="summary">
        <dt><b>Position size</b></dt><dd><b>{fmt(size)} mUSDC</b></dd>
        <dt>{mode === "market" ? "Entry (execution price)" : "Entry (limit)"}</dt><dd>{mode === "market" ? `$${fmt(entry)}` : `${isLong ? "≤" : "≥"} $${limit || "–"}`}</dd>
        <dt>Opening fee ({feeBps / 100}%)</dt><dd>{fmt(openFee)}{mode === "limit" ? " at fill" : ""}</dd>
        <dt>Collateral after fee</dt><dd>{fmt(net)}</dd>
        <dt>Closing fee</dt><dd>{fmt(ceilDiv(size * BigInt(feeBps), 10_000n))} at close</dd>
        <dt>Borrow fee</dt><dd>{fmt(borrowPerHour, 4)} / hour</dd>
      </dl>
      <dl className="summary risk">
        <dt>Liquidation price</dt><dd className="warn-text" title="Below maintenance margin a keeper closes it, taking a liquidation fee from what's left">{liq ? `≈ $${fmt(liq, 0)} (${((Number(liq - entry) / Number(entry)) * 100).toFixed(1)}%)` : "–"}</dd>
        <dt>Max loss</dt><dd>{fmt(collateral)} (the collateral)</dd>
        <dt>Max profit</dt><dd className="good">{state ? `${fmt(state.maxPayout, 0)} at a ${capMove.toFixed(1)}% move` : "–"}</dd>
      </dl>
      {!confirming ? (
        <button className={`primary ${side}`} disabled={!!problem || act.busy} onClick={() => setConfirming(true)}>
          {mode === "market" ? `Open ${side}` : `Place limit ${side}`} · {fmt(size, 0)} mUSDC</button>
      ) : (
        <div className="confirm">
          <span>{mode === "market"
            ? <>Open a <b>{side}</b> of <b>{fmt(size)} mUSDC</b> at <b>${fmt(entry)}</b>, posting <b>{fmt(collateral)} mUSDC</b> from a private note. If the price changes while proving, nothing opens and you are asked again.</>
            : <>Place a limit <b>{side}</b> of <b>{fmt(size)} mUSDC</b> at <b>${limit}</b>, escrowing <b>{fmt(collateral)} mUSDC</b>. You can cancel until a keeper fills it.</>}</span>
          <div className="row"><button className="ghost" onClick={() => setConfirming(false)}>Back</button><button className="primary" style={{ flex: 1 }} onClick={submit}>Confirm and prove</button></div>
        </div>
      )}
      {problem && !act.busy && <span className="small muted">{problem}</span>}
      {act.view}
    </div>
  );
}
