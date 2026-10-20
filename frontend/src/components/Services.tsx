import { useServices } from "../lib/hooks";

/** The backend (circuits/services under pm2): oracle signers, keepers, relayer. */
export function ServicesPanel() {
  const [s] = useServices();
  if (!s) return <div className="small muted">Checking the backend…</div>;
  const tone = (st?: string) => (!st ? "bad" : st === "ok" ? "good" : st === "starting" ? "accent" : "warn");
  return (
    <div className="services">
      {s.oracles.map((h, i) => (
        <div key={`o${i}`}><b>Oracle signer {i + 1}</b><span className={`chip ${tone(h?.status)}`}>{h?.status ?? "down"}</span>
          {h && <div className="muted" style={{ marginTop: 4 }}>submitted {String(h.submissions ?? 0)}</div>}</div>
      ))}
      {s.keepers.map((h, i) => (
        <div key={`k${i}`}><b>Keeper {i + 1}</b><span className={`chip ${tone(h?.status)}`}>{h?.status ?? "down"}</span>
          {h && <div className="muted" style={{ marginTop: 4 }}>{String((h.actions as unknown[] | undefined)?.length ?? 0)} recent actions</div>}</div>
      ))}
      <div><b>Relayer</b><span className={`chip ${s.relay ? "good" : "bad"}`}>{s.relay ? "up" : "down"}</span>
        <div className="muted" style={{ marginTop: 4 }}>submits private transactions</div></div>
    </div>
  );
}

export function useBackendUp() {
  const [s] = useServices();
  return { keepersUp: s ? s.keepers.filter((k) => k && k.status !== "stale").length : null, relay: s?.relay ?? null };
}
