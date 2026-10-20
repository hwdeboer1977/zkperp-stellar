import { useMemo } from "react";
import type { Config } from "../lib/config";
import { usePoll, useNow, type VaultState } from "../lib/hooks";
import { describe, vaultEvents } from "../lib/activity";
import { fmt, ago } from "../lib/format";
import { Stat } from "../components/ui";
import { ServicesPanel, useBackendUp } from "../components/Services";

function PriceLine({ points }: { points: { t: number; p: number }[] }) {
  if (points.length < 2) return <div className="muted small" style={{ padding: 40, textAlign: "center" }}>Not enough price updates in the RPC's ~16 h window yet.</div>;
  const W = 720, H = 220, P = 30, PR = 78; // PR: room for the price labels on the right
  const ts = points.map((x) => x.t), ps = points.map((x) => x.p);
  const t0 = Math.min(...ts), t1 = Math.max(...ts, t0 + 1), p0 = Math.min(...ps), p1 = Math.max(...ps, p0 + 1);
  const X = (t: number) => P + ((t - t0) / (t1 - t0)) * (W - P - PR), Y = (p: number) => H - P - ((p - p0) / (p1 - p0)) * (H - 2 * P);
  let d = `M${X(points[0].t)},${Y(points[0].p)}`;
  for (let i = 1; i < points.length; i++) d += ` H${X(points[i].t)} V${Y(points[i].p)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%" }}>
      {[0, 1, 2, 3].map((i) => { const p = p0 + ((p1 - p0) * i) / 3; return <g key={i}><line x1={P} x2={W - PR} y1={Y(p)} y2={Y(p)} stroke="var(--border)" /><text x={W - PR + 8} y={Y(p) + 4} fill="var(--muted)" fontSize="11" fontFamily="var(--mono)">{p.toLocaleString("en-US", { maximumFractionDigits: 0 })}</text></g>; })}
      <path d={d} fill="none" stroke="var(--accent-2)" strokeWidth="2" />
      {points.map((x, i) => <circle key={i} cx={X(x.t)} cy={Y(x.p)} r="3" fill="var(--accent-2)"><title>${x.p.toFixed(2)} · set {new Date(x.t * 1000).toLocaleString()}</title></circle>)}
    </svg>
  );
}

export default function PublicPage({ config, vault, state }: { config: Config; vault: string; state: VaultState | null }) {
  const [events] = usePoll(() => vaultEvents(config, vault), 30_000, [vault]);
  const now = useNow(5000);
  const { keepersUp } = useBackendUp();
  const prices = useMemo(() => (events ?? []).filter((e) => e.name === "price_set").map((e) => ({ t: Number(e.data.time), p: Number(e.data.price) / 1e7 })), [events]);
  const counts = useMemo(() => {
    const c = { opened: 0, closed: 0, liquidated: 0 };
    for (const e of events ?? []) {
      if (["private_opened", "position_opened", "limit_filled"].includes(e.name)) c.opened++;
      if (["position_closed", "order_executed"].includes(e.name)) c.closed++;
      if (e.name === "position_liquidated") c.liquidated++;
    }
    return c;
  }, [events]);
  const age = state?.mark ? now - Number(state.mark.time) : 0, maxAge = state ? Number(state.config.max_price_age) : 1;
  const slots = state ? Number(state.pool / state.maxPayout) : 0;
  return (
    <>
      <p className="eyebrow">Public ledger</p>
      <h1>Public by design. <span className="soft">Private by default.</span></h1>
      <p className="lead">Everything on this page is read from the Stellar ledger, and anyone can check it. What it never shows — a position's size, collateral, direction or owner — is the point of zkperp.</p>
      {state && (
        <div className="stats">
          <Stat label="Pool liquidity" value={fmt(state.pool)} unit="mUSDC" sub={`${fmt(state.shares)} zLP · ${state.shares > 0n ? (Number(state.pool) / Number(state.shares)).toFixed(4) : "1.0000"} mUSDC per zLP`} />
          <Stat label="Reserved for positions" value={fmt(state.reserved)} unit="mUSDC" sub={`${state.live} of ${slots} slots of ${fmt(state.maxPayout, 0)} max payout in use`}
            meter={slots ? state.live / slots : 0} tone={slots && state.live / slots > 0.8 ? "warn" : undefined} />
          <Stat label="Open positions" value={state.live} sub={`last ~16 h: ${counts.opened} opened · ${counts.closed} closed · ${counts.liquidated} liquidated · ${keepersUp ?? "?"} of 3 keepers up`} />
          <Stat label="Mark price · BTC/USD" value={state.mark ? `$${fmt(state.mark.price)}` : "–"} sub={state.mark ? `${ago(age)} old of ${Math.floor(maxAge / 60)} min max · signed by signers ${state.mark.signers.map((s) => s + 1).join(" + ")}` : "no price yet"}
            meter={age / maxAge} tone={age >= maxAge ? "bad" : age / maxAge > 0.75 ? "warn" : undefined} />
        </div>
      )}
      <div className="grid-main">
        <div className="card">
          <div className="card-head"><h2>Mark price <span className="muted">as set on chain</span></h2><span className="chip plain">{prices.length} updates</span></div>
          <PriceLine points={prices} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Activity</h2><span className="chip accent">live from the RPC</span></div>
          <div className="feed">
            {(events ?? []).slice(-7).reverse().map((e) => { const d = describe(e); return (
              <div key={e.id}><span className={`ic ${d.tone ?? ""}`}>{d.icon}</span><span><div className="lbl">{d.label}</div><div className="det">{d.detail}</div></span><span className="when">{ago(now - e.at)}</span></div>
            ); })}
            {events && events.length === 0 && <div className="muted small">No events in the RPC window.</div>}
            {!events && <div className="muted small">Reading events…</div>}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>How a private trade moves <span className="muted">what each party sees</span></h2></div>
        <div className="flow">
          <div className="step"><b>Trader</b>in the browser, unlocked with a password<ul><li>Picks size, side and collateral</li><li>Spends a private note</li><li>Proves the open here: nothing private leaves the page</li></ul></div>
          <div className="arrow">→</div>
          <div className="step"><b>Relayer</b>submits the proof<ul><li>Pays the fee; the trader's account never appears</li><li>Can't change anything: the proof binds every value</li><li>Can only refuse</li></ul></div>
          <div className="arrow">→</div>
          <div className="step"><b>Soroban vault</b>public to everyone<ul><li>Checks the Groth16 proof</li><li>Stores a commitment and a nullifier</li><li>Reserves one max-payout slot</li></ul></div>
        </div>
      </div>
      <div className="split">
        <div>
          <h3>Public — anyone can read</h3>
          <ul>
            <li>Pool liquidity and zLP supply, so every LP deposit and withdrawal</li>
            <li>Reserved liquidity: open positions × the payout cap</li>
            <li>The mark price, its Chainlink round, and which two of three oracle signers signed it</li>
            <li>That a position opened, closed, or was liquidated, and when</li>
            <li>At a close, the PnL — it is the pool's change</li>
            <li>Shielding and unshielding: amount and account</li>
          </ul>
        </div>
        <div className="priv">
          <h3>Private — hidden from the public</h3>
          <ul>
            <li>A position's size, collateral and leverage</li>
            <li>Its direction — longs and shorts look alike</li>
            <li>Who owns it: a hash of a secret, not a wallet</li>
            <li>Which open a close belongs to</li>
            <li>Every individual fee (the treasury sees them)</li>
            <li>Stop-loss, take-profit and limit levels</li>
          </ul>
          <p className="small muted">The three keepers see every position (they must, to liquidate); none can close for you or move funds.</p>
        </div>
      </div>
      <div className="card"><div className="card-head"><h2>Backend</h2><span className="muted small">oracle signers, keepers and relayer (pm2)</span></div><ServicesPanel /></div>
    </>
  );
}
