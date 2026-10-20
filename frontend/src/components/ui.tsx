import { useEffect, useRef, useState, type ReactNode } from "react";
import { useWallet } from "../lib/wallet";
import { short } from "../lib/format";

export const Logo = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <defs>
      <linearGradient id="zk-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#8b6cff" />
        <stop offset="1" stopColor="#2dd4e6" />
      </linearGradient>
    </defs>
    <path d="M16 2.5 27 6.6v8.2c0 7-4.6 12.2-11 14.7C9.6 27 5 21.8 5 14.8V6.6Z" fill="url(#zk-g)" opacity="0.18" />
    <path d="M16 2.5 27 6.6v8.2c0 7-4.6 12.2-11 14.7C9.6 27 5 21.8 5 14.8V6.6Z" fill="none" stroke="url(#zk-g)" strokeWidth="1.8" />
    <path d="M10.5 19.5 14.5 14l3 3 4.5-6" fill="none" stroke="url(#zk-g)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10.5 19.5 14.5 14" fill="none" stroke="#e7ebf3" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="1.5 2.5" opacity="0.6" />
  </svg>
);

export const Coin = () => <span className="coin">₿</span>;

export function Stat({ label, value, unit, sub, meter, tone }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; meter?: number; tone?: "warn" | "bad" }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <small>{unit}</small>}</div>
      {sub && <div className="sub">{sub}</div>}
      {meter !== undefined && <div className={`meter ${tone ?? ""}`}><i style={{ width: `${Math.min(100, Math.max(0, meter * 100))}%` }} /></div>}
    </div>
  );
}

export function WalletButton() {
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (w.address)
    return (
      <span className="row">
        <span className="pill" title={w.address}>Freighter · {short(w.address)}{w.network && w.network !== "TESTNET" ? ` · ${w.network}!` : ""}</span>
        <button className="ghost small" onClick={w.disconnect}>Disconnect</button>
      </span>
    );
  return (
    <span className="row">
      <button className="primary small" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { await w.connect(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
      }}>{busy ? "Connecting…" : "Connect wallet"}</button>
      {!w.installed && <span className="small muted">Install <a href="https://www.freighter.app" target="_blank" rel="noreferrer">Freighter</a> (testnet)</span>}
      {err && <span className="small bad">{err}</span>}
    </span>
  );
}

export const NeedsWallet = ({ what }: { what: string }) => (
  <div className="card flat muted">Connect a Stellar wallet (Freighter, on testnet) to {what}. Private steps are proven in this browser and submitted by the relayer, so your wallet only signs the public ones.</div>
);

/** Progress through a proof-and-submit: steps with elapsed seconds. */
export function Steps({ steps, active, failed }: { steps: string[]; active: number; failed?: boolean }) {
  const started = useRef<number[]>([]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t); }, []);
  if (started.current[active] === undefined) started.current[active] = Date.now();
  return (
    <ol className="steps">
      {steps.map((s, i) => {
        const state = i < active ? "done" : i === active && !failed ? "active" : "todo";
        const t0 = started.current[i], t1 = started.current[i + 1] ?? Date.now();
        return (
          <li key={i} className={state}>
            <span className="dot">{state === "done" ? "✓" : i + 1}</span>{s}
            {t0 !== undefined && <span className="t">{Math.round((t1 - t0) / 1000)}s</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Runs an action with progress steps; returns [run, view]. */
export function useAction() {
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReactNode>(null);
  const run = async (f: (step: (s: string) => void) => Promise<ReactNode>) => {
    setBusy(true); setError(null); setDone(null); setSteps([]);
    try {
      const r = await f((s) => setSteps((x) => [...x, s]));
      setDone(r ?? "Done.");
    } catch (e) {
      setError(String((e as Error).message ?? e).split("\n")[0].slice(0, 400));
    } finally {
      setBusy(false);
    }
  };
  const view = (
    <>
      {steps.length > 0 && (busy || error) && <Steps steps={steps} active={busy ? steps.length - 1 : steps.length} failed={!!error} />}
      {error && <div className="banner bad">Failed: {error}</div>}
      {done && !error && !busy && <div className="banner ok">{done}</div>}
    </>
  );
  return { run, busy, view, reset: () => { setError(null); setDone(null); setSteps([]); } };
}
