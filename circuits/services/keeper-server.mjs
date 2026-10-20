// Keeper backend server (step 14): runs keeper n and serves its status.
//   node services/keeper-server.mjs --keeper 1      # port 3040 + n (KEEPER_PORT to override)
//
//   GET /health    status (ok / price-stale / stale / starting), mark price and
//                  age, counts of tracked positions / orders / limits, recent
//                  actions, errors, this keeper's fee credit. Never decrypted
//                  position data.
//   GET /metrics   the same as Prometheus gauges
//
// The keeper loop runs in a child process (services/worker.mjs); this process
// only serves HTTP, so it answers instantly. Binds to 127.0.0.1.
// Under pm2: services/ecosystem.config.cjs.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve, metrics } from "../lib/http.mjs";
import { cfg } from "../lib/stellar.mjs";

const i = process.argv.indexOf("--keeper");
const n = Number(i >= 0 ? process.argv[i + 1] : process.env.KEEPER);
if (![1, 2, 3].includes(n)) { console.error("say which keeper this is: --keeper 1, 2 or 3"); process.exit(1); }
const tickMs = Number(cfg("KEEPER_TICK_MS") ?? 10_000);
const port = Number(process.env.KEEPER_PORT ?? 3040 + n);

let snap = null;
const worker = fork(fileURLToPath(new URL("./worker.mjs", import.meta.url)), ["keeper", String(n)]);
worker.on("message", (m) => {
  if (m.type === "snapshot") snap = m.state;
  if (m.type === "fatal") { console.error(m.message); process.exit(1); }
});
worker.on("error", (e) => { console.error(e); process.exit(1); });
worker.on("exit", (code) => { console.error(`loop exited (${code}); restarting via pm2`); process.exit(code || 1); });

function status() {
  if (!snap) return { status: "starting", keeper: n };
  const sinceTick = snap.lastTick ? Date.now() - Date.parse(snap.lastTick) : Infinity;
  const s = !snap.lastTick ? "starting" : sinceTick > 6 * tickMs + 120_000 ? "stale"
    : snap.mark && snap.mark.ageSeconds > snap.mark.maxAgeSeconds ? "price-stale" : "ok";
  return { status: s, ...snap };
}

serve({
  port,
  log: (m) => console.log(`${new Date().toISOString()} [keeper ${n}] ${m}`),
  routes: {
    "GET /health": () => status(),
    "GET /metrics": () => {
      const s = status();
      return metrics("zkperp_keeper", {
        up: ["1 if the keeper ticked recently", ["ok", "price-stale"].includes(s.status) ? 1 : 0],
        ticks_total: ["Ticks completed", s.ticks],
        errors_total: ["Tick errors", s.errors],
        positions_tracked: ["Open positions tracked", s.tracked?.positions],
        orders_tracked: ["Open stop-loss / take-profit orders tracked", s.tracked?.orders],
        limits_tracked: ["Open limit orders tracked", s.tracked?.limits],
        due: ["Actions due (liquidations, orders, fills)", s.due],
        mark_price_age_seconds: ["Age of the vault's mark price", s.mark?.ageSeconds],
        actions_recent: ["Actions in the recent log", s.actions?.length],
        owed_units: ["Fee credit owed to this keeper (token units)", s.owed],
      });
    },
  },
});
process.on("SIGTERM", () => { worker.kill(); process.exit(0); });
