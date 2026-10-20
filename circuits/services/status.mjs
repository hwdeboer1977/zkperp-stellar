// One-table health view of the backend:  node services/status.mjs
// Reads each server's /health (oracle 3020-3022, keepers 3041-3043).
const fmt = (x) => (x === null || x === undefined ? "-" : x);
const get = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return null; }
};
const rows = [];
for (const n of [1, 2, 3]) {
  const h = await get(3019 + n);
  if (h?.status === "starting") { rows.push([`oracle-${n}`, "starting", "", "", ""]); continue; }
  rows.push([`oracle-${n}`, h ? h.status : "DOWN", h ? `chainlink round …${String(h.lastRound?.round ?? "").slice(-4)} (${fmt(h.chainlinkRoundAgeSeconds)} s old)` : "",
    h?.vaultPrice ? `vault ${(Number(h.vaultPrice.price) / 1e7).toFixed(2)}, ${h.vaultPrice.ageSeconds} s old` : "", h ? `submitted ${h.submissions}` : ""]);
}
for (const n of [1, 2, 3]) {
  const h = await get(3040 + n);
  if (h?.status === "starting") { rows.push([`keeper-${n}`, "starting", "", "", ""]); continue; }
  rows.push([`keeper-${n}`, h ? h.status : "DOWN", h ? `${h.ticks} ticks, last ${h.lastTick?.slice(11, 19) ?? "-"}` : "",
    h ? `tracking ${h.tracked.positions} pos / ${h.tracked.orders} orders / ${h.tracked.limits} limits` : "",
    h ? `actions ${h.actions.length}, errors ${h.errors}, owed ${(Number(h.owed ?? 0) / 1e7).toFixed(2)}` : ""]);
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join("  "));
