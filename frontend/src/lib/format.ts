// Amounts: 7 decimals (mUSDC and prices).
export const UNIT = 10_000_000n;
export const toUnits = (x: string | number): bigint => {
  const [i, f = ""] = String(x).trim().split(".");
  return BigInt(i || "0") * UNIT + BigInt((f + "0000000").slice(0, 7));
};
export const fmt = (v: bigint | string | number | null | undefined, digits = 2) => {
  if (v === null || v === undefined) return "–";
  const n = Number(BigInt(v)) / 1e7;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
export const short = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
export const ago = (seconds: number) =>
  seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
