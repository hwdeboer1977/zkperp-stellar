// The position key, as in zkperp-midnight: derived from a password and the
// wallet account (a wallet signature would be phishable: any site could ask
// for the same signature). PBKDF2-SHA256 (WebCrypto, 600,000 iterations) ->
//   ownerSecret  : owns every note and position you make here (248 bits)
//   storage key  : AES-GCM key that encrypts your records in this browser.
// A wrong password doesn't fail: it unlocks a different, empty key. The key
// lives in page memory only; reload or Lock forgets it.
import { useSyncExternalStore } from "react";

export interface PositionKey { account: string; ownerSecret: bigint; storageKey: CryptoKey; id: string }

let current: PositionKey | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const useKey = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);
export const lockKey = () => { current = null; emit(); };
export const currentKey = () => current;

const te = new TextEncoder();
async function hkdf(root: CryptoKey, info: string, bits: number) {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: te.encode(info) }, root, bits));
}

export async function unlock(password: string, account: string) {
  const pw = await crypto.subtle.importKey("raw", te.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(`zkperp-soroban/password-salt/v1:${account}`)));
  const rootBits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 }, pw, 256);
  const root = await crypto.subtle.importKey("raw", rootBits, "HKDF", false, ["deriveBits"]);
  const owner = await hkdf(root, "zkperp-soroban/owner-secret/v1", 256);
  const aes = await hkdf(root, "zkperp-soroban/storage-key/v1", 256);
  const idBytes = await hkdf(root, "zkperp-soroban/storage-id/v1", 64);
  const ownerSecret = BigInt("0x" + Array.from(owner, (b) => b.toString(16).padStart(2, "0")).join("")) >> 8n;
  const storageKey = await crypto.subtle.importKey("raw", aes, "AES-GCM", false, ["encrypt", "decrypt"]);
  current = { account, ownerSecret, storageKey, id: Array.from(idBytes, (b) => b.toString(16).padStart(2, "0")).join("") };
  emit();
  return current;
}

/** Password check (as Midnight): at least 16 characters, 6 distinct. */
export const passwordProblem = (p: string) =>
  p.length < 16 ? "At least 16 characters." : new Set(p).size < 6 ? "Use at least 6 different characters." : null;

const WORDS = ("acid aisle alarm album alpha amber angle apple arena armor atlas aunt autumn bacon badge baker bamboo banjo barn basin beach beard berry bison blade blaze bloom board bolt bonus boost brave bread brick bridge brisk broom brush cabin cable cactus camel candle canoe canyon cargo carpet castle cedar chalk charm chess chief cider cliff cloud clover cobra comet coral cotton crane crisp crown cube daisy dance delta denim desk diary dingo dolphin donut dragon drift eagle easel ember empire engine falcon fable fern fiber flame flint forest fossil fresh frost garlic gecko ginger glacier globe grape gravel guitar harbor hazel helmet honey horizon iris island ivory jacket jaguar jelly jungle kayak kernel kettle koala ladder lagoon lantern lemon lilac lizard lobster lotus magnet mango maple marble meadow melon meteor mint mirror mosaic motor nectar noble nugget oasis ocean olive onion orbit otter oyster paddle panda papaya parrot pebble pepper piano pilot plume polar poppy prism pulse quartz quilt rabbit radar raven reef ribbon river robin rocket ruby saddle salmon satin scarf shadow shell silver sketch slate sonic spice spiral sprout squid stamp storm sugar summit swan tango temple thistle thunder tiger timber topaz tornado tulip tundra turtle umbrella valley velvet violet volcano walnut walrus willow window winter wizard yacht yogurt zebra zinc").split(" ");
/** Six random words joined by '-', as zkperp-midnight's generated password. */
export function generatePassword() {
  const r = crypto.getRandomValues(new Uint32Array(6));
  return Array.from(r, (x) => WORDS[x % WORDS.length]).join("-");
}
