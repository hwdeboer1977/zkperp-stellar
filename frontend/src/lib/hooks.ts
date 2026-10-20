import { useEffect, useState } from "react";
import { loadConfig, selectedVault, type Config } from "./config";
import { read } from "./chain";

export function useConfig() {
  const [c, setC] = useState<Config | null>(null);
  useEffect(() => { loadConfig().then(setC); }, []);
  return c;
}
export const useVaultId = (c: Config | null) => (c ? selectedVault(c) : null);

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Polls `f` every `ms`; returns [value, error, refresh]. */
export function usePoll<T>(f: (() => Promise<T>) | null, ms: number, deps: unknown[] = []): [T | null, string | null, () => void] {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!f) return;
    let live = true;
    const run = () => f().then((x) => { if (live) { setV(x); setErr(null); } }).catch((e) => live && setErr(String(e.message ?? e)));
    run();
    const t = setInterval(run, ms);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, n, ...deps]);
  return [v, err, () => setN((x) => x + 1)];
}

export interface VaultState {
  mark: { price: bigint; time: bigint; round: bigint; signers: number[] } | null;
  config: { fee_bps: number; max_price_age: bigint; keeper_key: { x: bigint; y: bigint } };
  pool: bigint; shares: bigint; live: number; reserved: bigint; traderFunds: bigint; owed: bigint;
  maxPayout: bigint; borrowRate: number; withdrawable: bigint;
  liq: { maintenance_bps: number; liquidation_fee_bps: number; keepers: string[] } | null;
}

export async function readVault(c: Config, id: string): Promise<VaultState> {
  const r = <T,>(fn: string, args?: Record<string, unknown>) => read<T>(c, id, fn, args);
  const [mark, config, pool, shares, live, reserved, traderFunds, owed, maxPayout, borrowRate, withdrawable, liq] = await Promise.all([
    r<VaultState["mark"]>("mark_price").catch(() => null), r<VaultState["config"]>("perp_config"), r<bigint>("pool_value"), r<bigint>("total_shares"),
    r<number>("live_positions"), r<bigint>("reserved"), r<bigint>("trader_funds"), r<bigint>("keeper_owed_total").catch(() => 0n),
    r<bigint>("max_payout"), r<number>("borrow_rate").catch(() => 0), r<bigint>("withdrawable"), r<VaultState["liq"]>("liquidation_config").catch(() => null),
  ]);
  return { mark, config, pool, shares, live: Number(live), reserved, traderFunds, owed, maxPayout, borrowRate: Number(borrowRate), withdrawable, liq };
}

export const useVault = (c: Config | null, id: string | null) =>
  usePoll(c && id ? () => readVault(c, id) : null, 8000, [c, id]);

/** Health of the backend services (proxied under /svc). */
export interface Health { status: string; [k: string]: unknown }
export async function services(): Promise<{ oracles: (Health | null)[]; keepers: (Health | null)[]; relay: boolean }> {
  const get = async (p: string) => { try { const r = await fetch(p, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch { return null; } };
  const [o1, o2, o3, k1, k2, k3] = await Promise.all(["/svc/oracle/1/health", "/svc/oracle/2/health", "/svc/oracle/3/health", "/svc/keeper/1/health", "/svc/keeper/2/health", "/svc/keeper/3/health"].map(get));
  const relay = await fetch("/svc/relay/relay", { method: "GET", signal: AbortSignal.timeout(3000) }).then((r) => r.status === 404).catch(() => false);
  return { oracles: [o1, o2, o3], keepers: [k1, k2, k3], relay };
}
export const useServices = () => usePoll(services, 15000);
