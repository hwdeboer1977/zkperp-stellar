import { useState } from "react";
import type { Config } from "../lib/config";
import { useWallet } from "../lib/wallet";
import { usePoll, type VaultState } from "../lib/hooks";
import { read, tokenBalance, write } from "../lib/chain";
import { fmt, toUnits } from "../lib/format";
import { useKey } from "../lib/positionKey";
import { useRecords } from "../lib/store";
import { withdrawNote } from "../lib/trading";
import { NeedsWallet, Stat, useAction } from "../components/ui";

export default function LiquidityPage({ config, vault, state }: { config: Config; vault: string; state: VaultState | null }) {
  const w = useWallet();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amt, setAmt] = useState("");
  // Deposit from the wallet (public mUSDC), or from a private note: unshield
  // it to your own wallet (relayer, no signature), then deposit (one signature).
  const [source, setSource] = useState<"wallet" | "private">("wallet");
  const key = useKey();
  const records = useRecords();
  const largestNote = records.notes.filter((n) => !n.spent).reduce((m, n) => (BigInt(n.amount) > m ? BigInt(n.amount) : m), 0n);
  const fromPrivate = mode === "deposit" && source === "private";
  const [mine, mineErr, refresh] = usePoll(w.address ? async () => ({ shares: await read<bigint>(config, vault, "shares_of", { lp: w.address }), wallet: await tokenBalance(config, w.address!).catch(() => 0n) }) : null, 10000, [w.address, vault]);
  const act = useAction();
  const price = state && state.shares > 0n ? Number(state.pool) / Number(state.shares) : 1;
  const units = (() => { try { return amt ? toUnits(amt) : 0n; } catch { return 0n; } })();
  const myWorth = mine && state && state.shares > 0n ? (mine.shares * state.pool) / state.shares : 0n;
  const available = fromPrivate ? largestNote : mine?.wallet;
  const problem = !w.address ? "" : fromPrivate && !key ? "Unlock your position key on the Portfolio page to use your private balance."
    : fromPrivate && largestNote === 0n ? "You have no private notes."
    : mode === "deposit" && !fromPrivate && mine && mine.wallet === 0n ? (largestNote > 0n ? "Your wallet holds no mUSDC. Choose \"From private balance\" above, or mint on the Faucet page." : "Your wallet holds no mUSDC. Mint some on the Faucet page, then deposit here.")
    : !units ? "Enter an amount."
    : fromPrivate && units > largestNote ? `Your largest private note holds ${fmt(largestNote)} mUSDC (one note per deposit).`
    : mode === "deposit" && !fromPrivate && mine && units > mine.wallet ? `Your wallet holds ${fmt(mine.wallet)} mUSDC.`
    : mode === "withdraw" && mine && units > mine.shares ? `You hold ${fmt(mine.shares)} zLP.` : "";
  return (
    <>
      <p className="eyebrow">Liquidity pool</p>
      <h1>Earn fees. <span className="soft">Be the traders' counterparty.</span></h1>
      <p className="lead">The pool pays traders' profits and keeps their losses, and receives 70% of trading fees when the treasury collects them. You hold zLP shares of it. Deposits and withdrawals are public token transfers.</p>
      {state && (
        <div className="stats">
          <Stat label="Pool value" value={fmt(state.pool)} unit="mUSDC" sub={`${fmt(state.shares)} zLP in issue`} />
          <Stat label="zLP share price" value={price.toFixed(6)} sub={`${((price - 1) * 100).toFixed(4)}% since launch, all PnL and fees in`} />
          <Stat label="Reserved for positions" value={fmt(state.reserved)} unit="mUSDC" meter={state.pool ? Number(state.reserved) / Number(state.pool) : 0} sub={`${state.live} open × ${fmt(state.maxPayout, 0)} max payout`} />
          <Stat label="Withdrawable now" value={fmt(state.withdrawable)} unit="mUSDC" sub="everything not reserved, across all LPs" />
        </div>
      )}
      <div className="grid-main">
        <details className="card" open>
          <summary>How LP returns work <span className="muted">and what can go wrong</span></summary>
          <div className="inspect">
            <div><b>Shares</b><br />The first deposit mints 1 zLP per mUSDC; later ones are pro rata, rounded in the pool's favour.</div>
            <div><b>Trader PnL</b><br />A trader's profit is paid from the pool, a loss goes into it. Closing fees and borrow fees go to the treasury, 70% of which reaches the pool.</div>
            <div><b>Worst case per position</b><br />A profit is capped at {state ? fmt(state.maxPayout, 0) : "…"} mUSDC (an enforced take-profit), so no single position can cost more.</div>
            <div><b>Reserved liquidity</b><br />Each open position reserves one max payout; that part of the pool can't be withdrawn until it closes.</div>
            <div><b>Capacity</b><br />No new position opens if the pool can't back one more max payout.</div>
            <div><b>Privacy</b><br />Deposits and withdrawals are public (amount and account). Traders' positions are not.</div>
          </div>
        </details>
        <div className="sticky">
          <div className="card">
            <div className="card-head"><h2>Your liquidity</h2></div>
            {w.address && mine ? (
              <dl className="summary">
                <dt>zLP held</dt><dd>{fmt(mine.shares)}</dd>
                <dt>Worth</dt><dd>{fmt(myWorth)} mUSDC</dd>
                <dt>Share of pool</dt><dd>{state && state.shares > 0n ? ((Number(mine.shares) / Number(state.shares)) * 100).toFixed(2) : "0"}%</dd>
                <dt>Wallet</dt><dd>{fmt(mine.wallet)} mUSDC</dd>
              </dl>
            ) : w.address ? (
              <p className="small muted">{mineErr ? <>Couldn't read your account: <span style={{ color: "var(--bad)" }}>{mineErr}</span>. Retrying every 10 s.</> : "Reading your account…"}</p>
            ) : <NeedsWallet what="provide liquidity" />}
          </div>
          {w.address && (
            <div className="card trade">
              <div className="toggle">
                <button className={`long ${mode === "deposit" ? "on" : ""}`} onClick={() => { setMode("deposit"); setAmt(""); }}>Deposit</button>
                <button className={`short ${mode === "withdraw" ? "on" : ""}`} onClick={() => { setMode("withdraw"); setAmt(""); }}>Withdraw</button>
              </div>
              {mode === "deposit" && (
                <div className="toggle">
                  <button className={source === "wallet" ? "on" : ""} onClick={() => { setSource("wallet"); setAmt(""); }}>From wallet</button>
                  <button className={source === "private" ? "on" : ""} onClick={() => { setSource("private"); setAmt(""); }}>From private balance</button>
                </div>
              )}
              <label><span className="label-row">{mode === "deposit" ? "Amount" : "zLP to redeem"}<span className="muted">{mode === "withdraw" ? `you hold ${fmt(mine?.shares)}` : fromPrivate ? `largest note ${fmt(largestNote)}` : `wallet ${fmt(mine?.wallet)}`}</span></span>
                <div className="input-unit"><input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0" /><span>{mode === "deposit" ? "mUSDC" : "zLP"}</span></div></label>
              <div className="quick">{[0.25, 0.5, 0.75, 1].map((f) => <button key={f} onClick={() => { const b = mode === "deposit" ? available : mine?.shares; if (b) setAmt((Number(b) * f / 1e7).toFixed(7).replace(/\.?0+$/, "")); }}>{f === 1 ? "Max" : `${f * 100}%`}</button>)}</div>
              <dl className="summary">
                <dt>Share price</dt><dd>{price.toFixed(6)}</dd>
                <dt>You receive</dt><dd>{mode === "deposit" ? `${(Number(units) / 1e7 / price).toFixed(4)} zLP` : `${(Number(units) / 1e7 * price).toFixed(4)} mUSDC`}</dd>
              </dl>
              <button className="primary" disabled={!!problem || act.busy} onClick={() => act.run(async (step) => {
                if (fromPrivate) {
                  await withdrawNote(config, vault, key!, records, units, w.address!, step);
                  step("Wait for the mUSDC in your wallet");
                  for (let i = 0; i < 20 && (await tokenBalance(config, w.address!)) < units; i++) await new Promise((r) => setTimeout(r, 1500));
                }
                step("Wallet signs the deposit");
                const fn = mode === "deposit" ? "deposit" : "withdraw";
                const r = await write<bigint>(config, vault, w.address!, w.sign, fn, mode === "deposit" ? { lp: w.address, amount: units } : { lp: w.address, shares: units });
                refresh(); setAmt("");
                return mode === "deposit" ? `Deposited; minted ${fmt(r)} zLP.` : `Redeemed; received ${fmt(r)} mUSDC.`;
              })}>{mode === "deposit" ? `Deposit ${amt || 0} mUSDC` : "Redeem zLP"}</button>
              {fromPrivate && !problem && <span className="small muted">Two steps: the relayer unshields the note to your wallet (no signature), then your wallet signs the deposit. The unshield links that note's amount to your account, as any public deposit would.</span>}
              {problem && <span className="small muted">{problem}</span>}
              {act.view}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
