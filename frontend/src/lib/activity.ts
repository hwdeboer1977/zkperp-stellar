// What the chain shows: the vault's events (RPC keeps ~16 h on testnet).
import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { rpcServer } from "./chain";
import type { Config } from "./config";

export interface ChainEvent { id: string; ledger: number; at: number; name: string; data: Record<string, unknown>; topics: unknown[] }

export async function vaultEvents(c: Config, vault: string): Promise<ChainEvent[]> {
  const s = rpcServer(c);
  const latest = (await s.getLatestLedger()).sequence;
  const out = new Map<string, ChainEvent>();
  // One request scans a limited range: walk forward in windows.
  for (let from = latest - 11_000; from <= latest; from += 5_000) {
    let res: rpc.Api.GetEventsResponse;
    try {
      res = await s.getEvents({ startLedger: Math.max(from, 1), filters: [{ type: "contract", contractIds: [vault] }], limit: 1000 });
    } catch { continue; }
    for (const e of res.events) {
      const topics = e.topic.map((t) => scValToNative(t));
      const value = scValToNative(e.value);
      out.set(e.id, { id: e.id, ledger: e.ledger, at: Date.parse(e.ledgerClosedAt) / 1000, name: String(topics[0]),
        data: typeof value === "object" && value !== null && !Array.isArray(value) ? value : { value }, topics: topics.slice(1) });
    }
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** How the public sees each event. */
export function describe(e: ChainEvent): { icon: string; label: string; detail: string; tone?: string } {
  const d = e.data as Record<string, bigint | string | number>;
  const m = (x: unknown) => (Number(x) / 1e7).toLocaleString("en-US", { maximumFractionDigits: 2 });
  switch (e.name) {
    case "position_opened": return { icon: "◆", label: "Position opened (public collateral)", detail: `leaf ${e.topics[0]} · collateral visible, size and side hidden` };
    case "private_opened": return { icon: "◆", label: "Position opened", detail: "size, side, collateral and owner hidden" };
    case "position_closed": return { icon: "✓", label: "Position closed", detail: `which open it was stays hidden · PnL ${Number(d.pool_out) > 0 ? "+" + m(d.pool_out) : Number(d.pool_in) > 0 ? "−" + m(d.pool_in) : "0"} at ${m(d.exit_price)}` };
    case "position_liquidated": return { icon: "!", label: "Position liquidated", detail: `by a keeper · loss ${m(d.pool_in)} to the pool`, tone: "bad" };
    case "order_executed": return { icon: "✓", label: "Stop loss / take profit executed", detail: `by a keeper at ${m(d.exit_price)} · which kind stays hidden` };
    case "order_placed": return { icon: "◇", label: "Order placed", detail: "a stop loss or take profit; position and level hidden" };
    case "order_cancelled": return { icon: "◇", label: "Order cancelled", detail: "" };
    case "limit_placed": return { icon: "◇", label: "Limit order placed", detail: "side, size and level hidden" };
    case "limit_filled": return { icon: "◆", label: "Limit order filled", detail: `by a keeper at ${m(d.entry_price)}; size and side hidden` };
    case "limit_cancelled": return { icon: "◇", label: "Limit order cancelled", detail: "" };
    case "price_set": return { icon: "◷", label: "Oracle price update", detail: `${m(d.price)} · signers ${(d.signers as unknown as number[]).map((x) => x + 1).join(" + ")}` };
    case "deposit": return { icon: "+", label: "Liquidity added", detail: `${m(d.amount)} mUSDC`, tone: "good" };
    case "withdraw": return { icon: "−", label: "Liquidity removed", detail: `${m(d.amount)} mUSDC` };
    case "note_deposited": return { icon: "↧", label: "Collateral shielded", detail: `${m(d.amount)} mUSDC into a private note` };
    case "note_withdrawn": return { icon: "↥", label: "Collateral unshielded", detail: `${m(d.amount)} mUSDC to ${String(d.recipient).slice(0, 6)}…` };
    case "notes_merged": return { icon: "⧉", label: "Notes merged", detail: "two notes into one; amounts hidden" };
    case "fees_collected": return { icon: "↧", label: "Fees collected", detail: `${m(d.amount)} mUSDC · ${m(d.to_pool)} to LPs` };
    case "keeper_paid": return { icon: "↥", label: "Keeper paid", detail: `${m(d.amount)} mUSDC` };
    default: return { icon: "·", label: e.name, detail: "" };
  }
}
