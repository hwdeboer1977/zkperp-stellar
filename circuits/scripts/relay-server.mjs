// Relay server: submits traders' private opens and withdrawals with the
// relayer's account (RELAYER_SECRET), so the trader's account never appears.
//   node scripts/relay-server.mjs            # listens on RELAYER_PORT (3030)
//   POST /relay {vault, fn, args}            fn: open_position_private | withdraw_note | close_position | …
//   POST /relay {vault, fn: "post_memo", args: {data: hex}}
//                                            posts an encrypted record to the memo board (MEMO_BOARD_ID, step 17)
// The proof binds every value, so the relayer can't change what it submits;
// it can only refuse. It pays the fees (no fee from the trader yet).
import http from "node:http";
import { cfg, invoke, secretOf } from "../lib/stellar.mjs";
import { RELAYABLE } from "../lib/relay.mjs";

const secret = secretOf("RELAYER");
const port = Number(cfg("RELAYER_PORT") ?? 3030);
// The real vault, and the demo vault if configured.
const allowedVaults = [cfg("VAULT_ID"), cfg("LIQ_DEMO_VAULT_ID")].filter(Boolean);
const memoBoard = cfg("MEMO_BOARD_ID");
const log = (s) => console.log(`${new Date().toISOString()} [relay] ${s}`);

http.createServer((req, res) => {
  const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method !== "POST" || req.url !== "/relay") return reply(404, { error: "POST /relay" });
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    try {
      const { vault, fn, args } = JSON.parse(data);
      if (!allowedVaults.includes(vault)) return reply(400, { error: "unknown vault" });
      if (fn === "post_memo") {
        const hex = String(args?.data ?? "");
        if (!memoBoard) return reply(400, { error: "no memo board configured (MEMO_BOARD_ID)" });
        if (!/^([0-9a-f]{2}){1,1024}$/.test(hex)) return reply(400, { error: "memo must be 1-1024 bytes of hex" });
        const result = invoke({ id: memoBoard, secret, fn: "post", args: { data: hex } });
        log(`post_memo (${hex.length / 2} bytes) -> ${JSON.stringify(result)}`);
        return reply(200, { result });
      }
      if (!RELAYABLE.includes(fn)) return reply(400, { error: `${fn} is not relayable` });
      const result = invoke({ id: vault, secret, fn, args });
      log(`${fn} -> ${JSON.stringify(result)}`);
      reply(200, { result });
    } catch (e) {
      const msg = String(e.stderr ?? e.message).split("\n").find((l) => l.includes("Error")) ?? String(e.message);
      log(`failed: ${msg}`);
      reply(400, { error: msg.slice(0, 300) });
    }
  });
}).listen(port, () => log(`listening on :${port} for ${allowedVaults.join(", ")}${memoBoard ? `, memo board ${memoBoard}` : ""}`));
