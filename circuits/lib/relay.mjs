// Submitting a private open or withdrawal without the trader's account:
// POST to the relay server (RELAYER_URL), or, if unset, sign directly with
// RELAYER_SECRET (as the relay server would).
import { cfg, invoke, secretOf } from "./stellar.mjs";

export const RELAYABLE = ["open_position_private", "withdraw_note", "close_position", "place_order", "cancel_order", "place_limit", "cancel_limit"];

export async function relay(vault, fn, args) {
  if (!RELAYABLE.includes(fn)) throw new Error(`${fn} is not relayable`);
  const url = cfg("RELAYER_URL");
  if (!url) return invoke({ id: vault, secret: secretOf("RELAYER"), fn, args });
  const res = await fetch(`${url.replace(/\/$/, "")}/relay`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault, fn, args }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`relay: ${body.error}`);
  return body.result;
}
