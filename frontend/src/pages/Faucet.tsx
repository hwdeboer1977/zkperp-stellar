import { useState } from "react";
import type { Config } from "../lib/config";
import { useWallet } from "../lib/wallet";
import { usePoll } from "../lib/hooks";
import { addTrustline, hasTrustline, mintFromFaucet, tokenBalance } from "../lib/chain";
import { fmt, toUnits } from "../lib/format";
import { NeedsWallet, useAction } from "../components/ui";
import { Link } from "react-router-dom";

export default function FaucetPage({ config }: { config: Config; vault: string }) {
  const w = useWallet();
  const [amount, setAmount] = useState("1000");
  const [acct, , refresh] = usePoll(w.address ? async () => ({ ...(await hasTrustline(config, w.address!)), balance: await tokenBalance(config, w.address!).catch(() => 0n) }) : null, 15000, [w.address]);
  const act = useAction();
  return (
    <>
      <p className="eyebrow">Test tokens</p>
      <h1>Get test mUSDC <span className="soft">to start trading.</span></h1>
      <p className="lead">mUSDC is a mock stablecoin for testing, with <b>no monetary value</b>: anyone can mint any amount. It's a real Stellar asset with a Stellar Asset Contract, like Circle's USDC, so the vault treats it exactly as it would the real thing.</p>
      <div className="grid-main">
        <div className="card trade">
          {!w.address ? <NeedsWallet what="mint test mUSDC" /> : (
            <>
              <label>Amount to mint<div className="input-unit"><input value={amount} onChange={(e) => setAmount(e.target.value)} /><span>mUSDC</span></div></label>
              <div className="quick three">{["1000", "5000", "10000"].map((a) => <button key={a} className={amount === a ? "on" : ""} onClick={() => setAmount(a)}>{Number(a).toLocaleString()}</button>)}</div>
              <dl className="summary">
                <dt>Token</dt><dd>{config.MUSDC_CODE} · test only</dd>
                <dt>Your balance</dt><dd>{acct ? fmt(acct.balance) : "…"} mUSDC (public)</dd>
                <dt>Network</dt><dd>{config.STELLAR_NETWORK}</dd>
                <dt>Fee</dt><dd>a little XLM, paid by your wallet</dd>
              </dl>
              <ul className="checks">
                <li>Wallet connected · Freighter</li>
                <li className={acct?.exists ? "" : "no"}>{acct?.exists ? "Account funded with XLM" : <>Account not funded: get testnet XLM from <a href={`https://friendbot.stellar.org?addr=${w.address}`} target="_blank" rel="noreferrer">Friendbot</a></>}</li>
                <li className={acct?.line ? "" : "no"}>{acct?.line ? "mUSDC trustline" : "No mUSDC trustline yet: minting adds it first (one more signature)"}</li>
              </ul>
              <button className="primary" disabled={act.busy || !acct?.exists} onClick={() => act.run(async (step) => {
                if (!acct?.line) { step("Wallet signs the mUSDC trustline"); await addTrustline(config, w.address!, w.sign); }
                step(`Wallet signs the mint of ${amount} mUSDC`);
                const r = await mintFromFaucet(config, w.address!, w.sign, toUnits(amount));
                refresh();
                return <>Minted {amount} mUSDC (tx {r.hash.slice(0, 10)}…). <Link to="/portfolio">Shield it into a private note →</Link></>;
              })}>{act.busy ? "Minting…" : `Mint ${Number(amount).toLocaleString()} mUSDC`}</button>
              {act.view}
            </>
          )}
        </div>
        <details className="card" open>
          <summary>Setup <span className="muted">and troubleshooting</span></summary>
          <h3 style={{ marginTop: 14 }}>1. Wallet</h3><p className="small muted">Install Freighter, create or import an account, and switch it to <b>Testnet</b>.</p>
          <h3>2. XLM</h3><p className="small muted">Fund the account with Friendbot (link on the left). XLM pays transaction fees.</p>
          <h3>3. Mint, shield, trade</h3><p className="small muted">Mint mUSDC here, shield it into a private note on the Portfolio page, then trade. Trades are proven in this browser and submitted by the relayer.</p>
        </details>
      </div>
    </>
  );
}
