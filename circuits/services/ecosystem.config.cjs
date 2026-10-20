// pm2 process file for the ZKPerp backend (steps 14-15):
//   cd circuits && pm2 start services/ecosystem.config.cjs     # everything
//   pm2 status | pm2 logs keeper-1 | pm2 stop all | pm2 delete all
//   node services/status.mjs                                   # one-table health view
// Every process reads .env (VAULT_ID, secrets). Logs: .zkperp/logs/ (gitignored).
// To start on boot: pm2 save && pm2 startup (then run the command it prints).
const path = require("node:path");
const cwd = path.resolve(__dirname, "..");
const logs = path.resolve(cwd, "../.zkperp/logs");
const app = (name, script, args, extra = {}) => ({
  name, script, args, cwd, interpreter: "node",
  autorestart: true, restart_delay: 5000, max_restarts: 50, min_uptime: "20s",
  out_file: `${logs}/${name}.out.log`, error_file: `${logs}/${name}.err.log`, time: true,
  ...extra,
});
module.exports = {
  apps: [
    // Price oracle (step 15): 3 signers; any 2 set each new Chainlink round.
    app("oracle-1", "services/oracle-server.mjs", "--signer 1"),
    app("oracle-2", "services/oracle-server.mjs", "--signer 2"),
    app("oracle-3", "services/oracle-server.mjs", "--signer 3"),
    // Keepers (step 14): liquidations, stop loss / take profit, limit fills.
    app("keeper-1", "services/keeper-server.mjs", "--keeper 1"),
    app("keeper-2", "services/keeper-server.mjs", "--keeper 2"),
    app("keeper-3", "services/keeper-server.mjs", "--keeper 3"),
    // Relayer for traders' private transactions (step 6).
    app("relay", "scripts/relay-server.mjs", ""),
    // Treasury (step 9): merge and collect fee notes once a day at 03:00.
    app("treasury", "scripts/treasury.mjs", "--collect", { autorestart: false, cron_restart: "0 3 * * *" }),
  ],
};
