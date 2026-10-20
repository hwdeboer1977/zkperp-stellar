// Minimal helpers around the stellar CLI and the repo's .env. Secrets come
// from .env (*_SECRET) and reach the CLI through its STELLAR_ACCOUNT
// environment variable, never as a command-line argument.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function loadEnv(path = ROOT + ".env") {
  const env = {};
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*(#.*)?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const fileEnv = loadEnv();
/** A setting: the process environment wins over .env. */
export const cfg = (key) => process.env[key] ?? fileEnv[key];

/** The secret (S...) in `<ROLE>_SECRET`, e.g. secretOf("ORACLE_1"). */
export function secretOf(role) {
  const s = cfg(`${role}_SECRET`);
  if (!s) throw new Error(`${role}_SECRET is not set in .env`);
  return s;
}

export const addressOf = (secret) => Keypair.fromSecret(secret).publicKey();

/**
 * Invokes a contract function, signed by `secret`. Objects in `args` are
 * JSON-encoded. Retries up to 3 times on network errors (connection reset,
 * timeouts): a repeated vault call is harmless, because a duplicate fails on
 * chain (StaleRound, NoteSpent) instead of acting twice.
 */
export function invoke({ id, secret, network = "testnet", fn, args = {}, send = true }) {
  const flat = Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync("stellar", ["contract", "invoke", "--id", id, "--network", network,
        ...(send ? [] : ["--send=no"]), "--", fn, ...flat],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, STELLAR_ACCOUNT: secret } }).trim();
      const last = out.split("\n").pop();
      try { return JSON.parse(last); } catch { return last; }
    } catch (e) {
      const network = /Networking or low-level protocol error|error trying to connect|timed out|Connection reset/i.test(String(e.stderr ?? ""));
      if (!network || attempt >= 3) throw e;
      execFileSync("sleep", [String(2 * attempt)]);
    }
  }
}

/** Appends or replaces KEY=value lines in .env (mode 600). */
export function setEnv(values, path = ROOT + ".env") {
  let text = fs.readFileSync(path, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    // Appending: start on a new line even if the file doesn't end with one.
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : text + (text && !text.endsWith("\n") ? "\n" : "") + `${k}=${v}\n`;
  }
  fs.writeFileSync(path, text, { mode: 0o600 });
}
