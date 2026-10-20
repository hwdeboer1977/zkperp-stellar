import { NavLink, Route, Routes } from "react-router-dom";
import { useConfig, useNow, useVault, useVaultId } from "./lib/hooks";
import { selectVault, vaults } from "./lib/config";
import { fmt, ago } from "./lib/format";
import { Logo, WalletButton } from "./components/ui";
import { useKey } from "./lib/positionKey";
import { useRecordsFor } from "./lib/store";
import { useMemoSync } from "./lib/memos";
import PublicPage from "./pages/Public";
import TradePage from "./pages/Trade";
import PortfolioPage from "./pages/Portfolio";
import LiquidityPage from "./pages/Liquidity";
import FaucetPage from "./pages/Faucet";

export default function App() {
  const config = useConfig();
  const vault = useVaultId(config);
  const [state, error] = useVault(config, vault);
  const now = useNow(5000);
  const key = useKey();
  const recordsReady = useRecordsFor(vault, key);
  useMemoSync(config, vault, key, recordsReady);
  const age = state?.mark ? now - Number(state.mark.time) : null;
  const maxAge = state ? Number(state.config.max_price_age) : 0;
  const stale = age !== null && age >= maxAge;
  return (
    <>
      <header>
        <NavLink to="/" className="brand" end>
          <Logo />
          <span>
            <span className="name">zk<b>perp</b></span>
            <span className="tag">Private perpetuals · Soroban</span>
          </span>
        </NavLink>
        {config && <span className="net">{config.STELLAR_NETWORK}</span>}
        <nav>
          <NavLink to="/" end>Public</NavLink>
          <NavLink to="/trade">Trade</NavLink>
          <NavLink to="/portfolio">Portfolio</NavLink>
          <NavLink to="/liquidity">Liquidity</NavLink>
          <NavLink to="/faucet">Faucet</NavLink>
        </nav>
        {config && vault && (
          <select className="picker" value={vault} onChange={(e) => selectVault(e.target.value)} title="vault">
            {vaults(config).map((v) => <option key={v.id} value={v.id}>{v.label} · {v.note}</option>)}
          </select>
        )}
        {state?.mark && (
          <span className={`ticker ${stale ? "bad" : ""}`} title={`price observed ${age}s ago; limit ${maxAge}s`}>
            <span className="pair">BTC/USD · {ago(age!)} ago</span>
            <span className="price">${fmt(state.mark.price)}</span>
          </span>
        )}
        <WalletButton />
      </header>
      {error && <div className="banner bad">Cannot read the vault: {error}</div>}
      {stale && (
        <div className="banner bad">
          The oracle price is {Math.floor(age! / 60)} minutes old, past its {Math.floor(maxAge / 60)}-minute limit. Trading — closes
          included — waits for the next price. Are the oracle signers running?
        </div>
      )}
      <main key={vault ?? ""}>
        {config && vault && (
          <Routes>
            <Route path="/" element={<PublicPage config={config} vault={vault} state={state} />} />
            <Route path="/trade" element={<TradePage config={config} vault={vault} state={state} />} />
            <Route path="/portfolio" element={<PortfolioPage config={config} vault={vault} state={state} />} />
            <Route path="/liquidity" element={<LiquidityPage config={config} vault={vault} state={state} />} />
            <Route path="/faucet" element={<FaucetPage config={config} vault={vault} />} />
          </Routes>
        )}
      </main>
    </>
  );
}
