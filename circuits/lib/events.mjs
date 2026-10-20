// Fetching a vault's events through the stellar CLI (testnet RPC keeps
// ~11,500 ledgers, and one request scans a limited range, so walk in windows).
import { execFileSync } from "node:child_process";

export function latestLedger() {
  return JSON.parse(execFileSync("curl", ["-s", "https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1"]))._embedded.records[0].sequence;
}

/** Events of `vault` from `start` (default: as far back as RPC keeps) to now, in order, deduplicated. */
export function vaultEvents(vault, start) {
  const latest = latestLedger();
  const from0 = Math.max(start ?? 0, latest - 11_000);
  const seen = new Map();
  for (let from = from0; from <= latest; from += 5_000) {
    const out = execFileSync("stellar", ["events", "--network", "testnet", "--id", vault, "--start-ledger", String(from), "--output", "json", "--count", "1000"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split("\n")) if (line.startsWith("{")) { const e = JSON.parse(line); seen.set(e.id, e); }
  }
  return { latest, events: [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}
