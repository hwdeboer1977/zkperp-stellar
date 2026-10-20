// What a keeper sees: fetches the vault's PositionOpened events, decrypts each
// keeper note with the shared view key (KEEPER_VIEW_SK in .env), and
// checks the decrypted fields hash to the on-chain commitment.
//   node scripts/keeper-read.mjs [start-ledger]
// Testnet RPC keeps events for only ~11,500 ledgers (~16 h); a real keeper persists them
// (ARCHITECTURE: note-state indexer).
import { execFileSync } from "node:child_process";
import { decryptNote, positionCommitment } from "../lib/keeper.mjs";
import { cfg, invoke, secretOf } from "../lib/stellar.mjs";
import { nullifierOf } from "../lib/notes.mjs";

const vault = cfg("VAULT_ID");
const key = { sk: cfg("KEEPER_VIEW_SK") };
if (!key.sk) throw new Error("KEEPER_VIEW_SK is not set in .env");
const latest = JSON.parse(execFileSync("curl", ["-s", "https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1"]))
  ._embedded.records[0].sequence;
const start = process.argv[2] ?? String(latest - 11_000);

// One request scans a limited ledger range, so walk forward in windows.
const seen = new Map();
for (let from = Number(start); from <= latest; from += 5_000) {
  const out = execFileSync("stellar", ["events", "--network", "testnet", "--id", vault, "--start-ledger", String(from),
    "--output", "json", "--count", "1000"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    const e = JSON.parse(line);
    if (e.event_name === "PositionOpened" || e.event_name === "PrivateOpened") seen.set(e.id, e);
  }
}
const opened = [...seen.values()].sort((a, b) => a.params.leaf_index - b.params.leaf_index);

const UNIT = 10_000_000n;
const fmt = (x) => (Number(x) / Number(UNIT)).toLocaleString("en-US", { maximumFractionDigits: 7 });
for (const e of opened) {
  const p = e.params;
  const d = await decryptNote(key.sk, [p.note_r.x, p.note_r.y], p.note);
  const ok = (await positionCommitment(d)).toString() === p.commitment;
  const tag = e.event_name === "PrivateOpened" ? "private" : "public ";
  // A keeper knows the salt, so it can tell whether the position is closed.
  const closed = invoke({ id: vault, secret: secretOf("RELAYER"), fn: "is_spent", send: false,
    args: { nullifier: (await nullifierOf(d.salt, p.leaf_index)).toString() } });
  console.log(`#${p.leaf_index} ${tag} ${d.isLong === 1n ? "LONG " : "SHORT"} size ${fmt(d.size)}  collateral ${fmt(d.collateral)}` +
    `  entry ${fmt(d.entryPrice)}  fee ${fmt(d.openFee)}  leverage ${(Number(d.size) / Number(d.collateral)).toFixed(2)}x` +
    `  commitment ${ok ? "matches" : "MISMATCH"}  ${closed ? "CLOSED" : "open"}`);
}
if (opened.length === 0) console.log("no PositionOpened events in range");
process.exit(0);
