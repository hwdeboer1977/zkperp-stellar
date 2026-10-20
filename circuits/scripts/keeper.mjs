// Runs keeper n in the foreground (no HTTP API):
//   node scripts/keeper.mjs --keeper 1      # and 2, 3
// For the server with /health and /metrics, use services/keeper-server.mjs.
import { startKeeper } from "../lib/keeper-service.mjs";

const i = process.argv.indexOf("--keeper");
const n = Number(i >= 0 ? process.argv[i + 1] : NaN);
if (![1, 2, 3].includes(n)) { console.error("say which keeper this is: --keeper 1, 2 or 3"); process.exit(1); }
try {
  await startKeeper(n);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
