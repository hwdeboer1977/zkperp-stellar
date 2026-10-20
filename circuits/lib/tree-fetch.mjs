// Fetching the vault's stored leaves through the stellar CLI (Node only).
import { invoke } from "./stellar.mjs";

/** All leaves stored by the vault, in order. */
export function fetchLeaves(vault, secret) {
  const count = Number(invoke({ id: vault, secret, fn: "position_count", send: false }));
  const leaves = [];
  for (let start = 0; start < count; start += 100) {
    const page = invoke({ id: vault, secret, fn: "leaves", args: { start, count: Math.min(100, count - start) }, send: false });
    leaves.push(...page.map(BigInt));
  }
  return leaves;
}
