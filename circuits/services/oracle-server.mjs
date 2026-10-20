// Price-oracle backend server (step 15): runs oracle signer n and serves it.
//   node services/oracle-server.mjs --signer 1      # port 3019 + n (peers expect these)
//
//   GET /signature/<round>  this signer's signature on that Chainlink round (for peers)
//   GET /health             status (ok / chainlink-stale / vault-price-stale / error / starting),
//                           last Chainlink round, the vault's price and its age, submissions
//   GET /price              the latest Chainlink BTC/USD and the vault's mark price
//   GET /metrics            Prometheus gauges
//
// The signer loop runs in a child process (services/worker.mjs); this process
// only serves HTTP, so peers always get signatures quickly. Binds to
// 127.0.0.1 unless ORACLE_HOST is set (peers on other machines).
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve, metrics } from "../lib/http.mjs";

const i = process.argv.indexOf("--signer");
const n = Number(i >= 0 ? process.argv[i + 1] : process.env.ORACLE_SIGNER);
if (![1, 2, 3].includes(n)) { console.error("say which signer this is: --signer 1, 2 or 3"); process.exit(1); }

let health = null;
const signed = new Map();
const worker = fork(fileURLToPath(new URL("./worker.mjs", import.meta.url)), ["oracle", String(n)]);
worker.on("message", (m) => {
  if (m.type === "snapshot") health = m.state;
  if (m.type === "signed") {
    signed.set(m.round, m.entry);
    for (const k of [...signed.keys()].slice(0, -10)) signed.delete(k);
  }
  if (m.type === "fatal") { console.error(m.message); process.exit(1); }
});
worker.on("error", (e) => { console.error(e); process.exit(1); });
worker.on("exit", (code) => { console.error(`loop exited (${code}); restarting via pm2`); process.exit(code || 1); });

function status() {
  if (!health) return { status: "starting", signer: n };
  const now = Math.floor(Date.now() / 1000);
  const roundAge = health.lastRound ? now - Number(health.lastRound.updatedAt) : null;
  const vp = health.vaultPrice;
  const s = health.lastError && Date.now() - Date.parse(health.lastError.at) < 60_000 ? "error"
    : roundAge !== null && roundAge > 2 * 3600 ? "chainlink-stale" // BTC/USD heartbeat is 1 h
    : vp && vp.ageSeconds > vp.maxAgeSeconds ? "vault-price-stale"
    : "ok";
  return { status: s, chainlinkRoundAgeSeconds: roundAge, ...health };
}

serve({
  host: process.env.ORACLE_HOST ?? "127.0.0.1",
  port: 3019 + n,
  log: (m) => console.log(`${new Date().toISOString()} [signer ${n}] ${m}`),
  routes: {
    "GET /signature/(\\d+)": (_, m) => signed.get(m[1]) ?? { error: "not signed" },
    "GET /health": () => status(),
    "GET /price": () => ({
      chainlink: health?.lastRound && { round: health.lastRound.round, price: (Number(health.lastRound.answer) / 1e8).toFixed(2), updatedAt: Number(health.lastRound.updatedAt) },
      vault: health?.vaultPrice && { round: health.vaultPrice.round, price: (Number(health.vaultPrice.price) / 1e7).toFixed(2), ageSeconds: health.vaultPrice.ageSeconds },
    }),
    "GET /metrics": () => {
      const s = status();
      return metrics("zkperp_oracle", {
        up: ["1 unless the signer is in error or starting", ["error", "starting"].includes(s.status) ? 0 : 1],
        polls_total: ["Chainlink polls", s.polls],
        submissions_total: ["Prices submitted by this signer", s.submissions],
        errors_total: ["Errors", s.errors],
        chainlink_round_age_seconds: ["Age of the latest Chainlink round", s.chainlinkRoundAgeSeconds],
        vault_price_age_seconds: ["Age of the vault's mark price", s.vaultPrice?.ageSeconds],
        vault_price: ["Vault mark price (USD)", s.vaultPrice ? Number(s.vaultPrice.price) / 1e7 : null],
      });
    },
  },
});
process.on("SIGTERM", () => { worker.kill(); process.exit(0); });
