// Private transactions go through the relayer (circuits/scripts/relay-server.mjs,
// proxied at /svc/relay), so your wallet never appears in them.
export async function relay(vault: string, fn: string, args: Record<string, unknown>) {
  const res = await fetch("/svc/relay/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault, fn, args }, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  }).catch(() => null);
  if (!res) throw new Error("The relayer is not reachable (is `pm2 start services/ecosystem.config.cjs` running?)");
  const body = await res.json().catch(() => ({ error: `relayer answered ${res.status}` }));
  if (!res.ok) throw new Error(`relayer: ${body.error}`);
  return body.result;
}
