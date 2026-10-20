// Public configuration (public/config.json, written by scripts/sync.mjs from
// ../.env's public values) and the selected vault.
export interface Config {
  STELLAR_NETWORK: string;
  STELLAR_NETWORK_PASSPHRASE: string;
  STELLAR_RPC_URL: string;
  HORIZON_URL: string;
  MUSDC_CODE: string;
  MUSDC_ISSUER: string;
  MUSDC_SAC: string;
  MUSDC_FAUCET_ID: string;
  COLLATERAL_SAC: string;
  COLLATERAL_DECIMALS: string;
  VAULT_ID: string;
  LIQ_DEMO_VAULT_ID?: string;
  RELAYER_ADDRESS: string;
  MAX_PAYOUT: string;
  /** The memo board holding traders' encrypted records (step 17). */
  MEMO_BOARD_ID?: string;
}

let cached: Config | null = null;
export async function loadConfig(): Promise<Config> {
  cached ??= await (await fetch("/config.json")).json();
  return cached!;
}

export interface VaultChoice { id: string; label: string; note: string }
export const vaults = (c: Config): VaultChoice[] => [
  { id: c.VAULT_ID, label: "BTC/USD", note: "live Chainlink price" },
  ...(c.LIQ_DEMO_VAULT_ID ? [{ id: c.LIQ_DEMO_VAULT_ID, label: "BTC/USD demo", note: "test prices" }] : []),
];

const KEY = "zkperp.vault";
export const selectedVault = (c: Config) => {
  try { return localStorage.getItem(KEY) ?? c.VAULT_ID; } catch { return c.VAULT_ID; }
};
export const selectVault = (id: string) => {
  try { localStorage.setItem(KEY, id); } catch {}
  location.reload();
};
