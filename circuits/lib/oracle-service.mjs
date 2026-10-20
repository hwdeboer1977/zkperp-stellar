// One oracle signer as a service (step 15): Chainlink -> the vault's
// set_price, signed by 2 of 3 signers. Used by services/oracle-server.mjs
// (HTTP API, which also serves signatures to peers) and scripts/relayer.mjs.
//
// One oracle signer: Chainlink BTC/USD (Ethereum) -> the vault's set_price,
// signed by 2 of 3 signers. Soroban port of zkperp-midnight's relayer.
//
//   node scripts/relayer.mjs --signer 1        # and 2, 3, each in its own terminal
//
// Polls Chainlink and acts only on a NEW round (a 0.5% move or the hourly
// heartbeat): pricing is strict, so re-stamping the same price would make
// every in-flight open fail. For each new round it signs the report
// (round, price, updatedAt) and serves the signature to its peers. Signer n
// waits (n - 1) x STAGGER_MS, then, unless the round is already on chain,
// fetches a peer's signature for the same report and submits both. Normally
// signer 1 submits; if it is down, signer 2 does, and so on. If two submit,
// exactly one lands; the other fails on chain (StaleRound) and pays its fee.
//
//   key      ORACLE_<n>_SECRET in .env (its ed25519 key signs, its account pays)
//   port     3019 + n
//   peers    ORACLE_PEERS (comma-separated URLs by signer), default localhost 3020-3022
//   source   EVM_RPC_URL, default https://ethereum-rpc.publicnode.com
//
//   GET /health              last round seen, the vault's price, this signer's state
//   GET /signature/<round>   this signer's signature on that round's report
import { latestRound } from "./chainlink.mjs";
import { priceDigest, sign, rawKey, toVaultPrice } from "./oracle.mjs";
import { cfg, invoke, secretOf, addressOf } from "./stellar.mjs";


/** Starts signer `n` (1-3). Returns { health, signed, port, stop }. */
export async function startSigner(n, { onSigned } = {}) {
const POLL_MS = Number(process.env.RELAYER_POLL_MS ?? 15_000); // Chainlink
const TICK_MS = Number(process.env.RELAYER_TICK_MS ?? 3_000); // our turn / peers
const STAGGER_MS = Number(process.env.RELAYER_STAGGER_MS ?? 20_000);
const log = (s) => console.log(`${new Date().toISOString()} [signer ${n}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slot = n - 1;
const vault = cfg("VAULT_ID");
const rpcUrl = cfg("EVM_RPC_URL") ?? "https://ethereum-rpc.publicnode.com";
const secret = secretOf(`ORACLE_${n}`);
const account = addressOf(secret);
const port = 3019 + n;
const peers = (process.env.ORACLE_PEERS ?? "http://127.0.0.1:3020,http://127.0.0.1:3021,http://127.0.0.1:3022")
  .split(",").map((url, s) => ({ slot: s, url: url.trim().replace(/\/$/, "") })).filter((p) => p.slot !== slot);

const ro = (fn) => invoke({ id: vault, secret, fn, send: false });
const config = ro("perp_config");
if (config.signers[slot] !== rawKey(account)) throw new Error(`ORACLE_${n}_SECRET (${account}) is not signer ${n} of vault ${vault}`);

const signed = new Map(); // round -> { report, sig, seenAt }
const health = { signer: n, vault, account, startedAt: new Date().toISOString(), submissions: 0, errors: 0, polls: 0 };
const vaultRound = () => {
  try { return BigInt(ro("mark_price").round); } catch { return -1n; }
};



async function peerSignature(round, report) {
  for (const p of peers) {
    try {
      const r = await fetch(`${p.url}/signature/${round}`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const j = await r.json();
      const same = BigInt(j.report.price) === report.price && BigInt(j.report.updatedAt) === report.updatedAt;
      if (same) return { slot: p.slot, sig: j.sig };
    } catch {}
  }
  return null;
}

let r, polledAt = 0;
async function tick() {
  if (Date.now() - polledAt >= POLL_MS) {
    r = await latestRound(rpcUrl);
    polledAt = Date.now();
    health.polls++;
    health.lastPoll = new Date().toISOString();
  }
  health.lastRound = { round: r.round, answer: r.answer, updatedAt: r.updatedAt };
  if (!signed.has(r.round)) {
    const report = { round: r.round, price: toVaultPrice(r.answer), updatedAt: r.updatedAt };
    const sig = sign(secret, priceDigest(vault, report.round, report.price, report.updatedAt));
    signed.set(r.round, { report, sig, seenAt: Date.now() });
    onSigned?.(r.round, signed.get(r.round));
    for (const k of [...signed.keys()].slice(0, -10)) signed.delete(k);
    log(`signed round ${r.round}: ${Number(report.price) / 1e7} (updatedAt ${report.updatedAt})`);
  }
  const mine = signed.get(r.round);
  const onChain = vaultRound();
  health.vaultRound = onChain;
  try {
    const m = ro("mark_price");
    health.vaultPrice = { price: m.price, round: m.round, ageSeconds: Math.floor(Date.now() / 1000) - m.time, maxAgeSeconds: config.max_price_age };
  } catch {}
  if (onChain >= r.round) return;
  if (Date.now() - mine.seenAt < slot * STAGGER_MS) return; // not our turn yet
  const peer = await peerSignature(r.round, mine.report);
  if (!peer) return log(`round ${r.round}: no peer signature yet`);
  const [a, b] = [{ slot, sig: mine.sig }, peer].sort((x, y) => x.slot - y.slot);
  try {
    invoke({
      id: vault, secret, fn: "set_price",
      args: { round: r.round.toString(), price: mine.report.price.toString(), updated_at: mine.report.updatedAt.toString(),
        first: a.slot, second: b.slot, sig_a: a.sig, sig_b: b.sig },
    });
    health.submissions++;
    health.lastSubmission = { round: r.round, with: [a.slot + 1, b.slot + 1], at: new Date().toISOString() };
    log(`submitted round ${r.round} with signers ${a.slot + 1}+${b.slot + 1}`);
  } catch (e) {
    const out = String(e.stderr ?? e.message);
    const line = out.split("\n").find((l) => /error/i.test(l)) ?? out.split("\n")[0];
    health.lastError = { message: line.slice(0, 300), at: new Date().toISOString() };
    log(`submit failed: ${health.lastError.message}`);
  }
}

let stopped = false;
(async () => {
  while (!stopped) {
    try { await tick(); } catch (e) { health.errors++; health.lastError = { message: e.message.slice(0, 300), at: new Date().toISOString() }; log(`error: ${e.message}`); }
    await sleep(TICK_MS);
  }
})();
return { health, signed, port, stop: () => { stopped = true; } };
}
