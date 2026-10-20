import { useState } from "react";
import { generatePassword, lockKey, passwordProblem, unlock, useKey } from "../lib/positionKey";
import { useWallet } from "../lib/wallet";
import { short } from "../lib/format";
import { useMemoStatus } from "../lib/memos";

/** Unlock (or create) your position key: password + wallet account, as on zkperp-midnight. */
export function PositionKeyPanel({ compact }: { compact?: boolean }) {
  const w = useWallet();
  const key = useKey();
  const [pw, setPw] = useState("");
  const [gen, setGen] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const memo = useMemoStatus();
  if (!w.address) return null;
  const unlocked = key && key.account === w.address;
  if (unlocked) {
    if (compact) return null;
    return (
      <div className="card flat row">
        <span className="chip good">Position key unlocked</span>
        <span className="small muted">for account {short(w.address, 6)}</span>
        <span className={`chip ${memo.error ? "bad" : memo.posting || memo.pending ? "warn" : memo.scanned ? "good" : "plain"}`}
          title="Your records are also stored encrypted on chain, so this wallet and password show them on any computer.">
          {memo.error ? "Not synced" : memo.posting || memo.pending ? `Saving ${memo.pending || ""} to chain…` : memo.scanned ? "Synced on chain" : "Reading your records from chain…"}
        </span>
        {memo.restored > 0 && <span className="small muted">{memo.restored} record(s) restored from chain</span>}
        {memo.error && <span className="small" style={{ color: "var(--bad)" }}>{memo.error}</span>}
        <button className="ghost small" style={{ marginLeft: "auto" }} onClick={lockKey}>Lock</button>
      </div>
    );
  }
  const go = async (password: string) => {
    setBusy(true);
    try { await unlock(password, w.address!); } finally { setBusy(false); setPw(""); setGen(null); }
  };
  const problem = passwordProblem(pw);
  return (
    <div className="card keypanel">
      <div className="card-head"><h2>Unlock your position key</h2><span className="chip accent">private</span></div>
      <div className="small muted">
        Your notes and positions are owned by a key derived from this password and your wallet account. It never leaves this
        page, and your records here are encrypted with it. A wrong password doesn't fail: it unlocks a different, empty key.
      </div>
      {gen ? (
        <>
          <div className="secret">{gen}</div>
          <div className="warn">Write it down. It can't be reset: without it, positions opened with it can't be closed. It is not a wallet recovery phrase.</div>
          <label className="inline"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved this password</label>
          <div className="row">
            <button className="primary" disabled={!saved || busy} onClick={() => go(gen)}>{busy ? "Deriving key…" : "Use this password"}</button>
            <button className="ghost" onClick={() => navigator.clipboard?.writeText(gen)}>Copy</button>
            <button className="ghost" onClick={() => setGen(null)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <input type="password" placeholder="Password (16+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !problem && go(pw)} />
          <div className="row">
            <button className="primary" disabled={!!problem || busy} onClick={() => go(pw)}>{busy ? "Deriving key…" : "Unlock"}</button>
            <button className="ghost" onClick={() => { setGen(generatePassword()); setSaved(false); }}>First time? Generate a password</button>
          </div>
          {pw && problem && <span className="small muted">{problem}</span>}
        </>
      )}
    </div>
  );
}
