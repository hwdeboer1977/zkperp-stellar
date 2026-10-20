// Chainlink BTC/USD on Ethereum mainnet: latestRoundData() over JSON-RPC.
// Same source as zkperp-midnight's relayer.
export const FEEDS = { "BTC-USD": "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c" };
const LATEST_ROUND_DATA = "0xfeaf968c";

export async function latestRound(rpcUrl, feed = FEEDS["BTC-USD"]) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: feed, data: LATEST_ROUND_DATA }, "latest"] }),
  });
  const { result, error } = await res.json();
  if (error || !result || result === "0x") throw new Error(`eth_call failed: ${JSON.stringify(error ?? result)}`);
  const word = (i) => BigInt("0x" + result.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  return { round: word(0), answer: word(1), updatedAt: word(3) }; // 8 decimals
}
