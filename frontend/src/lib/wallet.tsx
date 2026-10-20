// Freighter, the Stellar browser wallet. It signs the public steps only
// (faucet, LP deposit/withdraw, note deposit); private ones are proven in the
// browser and submitted by the relayer, so this account never appears in them.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import * as freighterNs from "@stellar/freighter-api";

// The package is CommonJS: under Vite its API sits on `default`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const freighter: typeof freighterNs = ((freighterNs as any).default ?? freighterNs) as typeof freighterNs;
import type { Signer } from "./chain";

interface Wallet {
  address: string | null;
  network: string | null;
  installed: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  sign: Signer;
  signMessage: (message: string) => Promise<Uint8Array>;
}
const Ctx = createContext<Wallet | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [installed, setInstalled] = useState(true);

  const refresh = useCallback(async () => {
    const c = await freighter.isConnected();
    setInstalled(!!c.isConnected);
    if (!c.isConnected) return;
    const allowed = await freighter.isAllowed();
    if (!allowed.isAllowed) return;
    const a = await freighter.getAddress();
    if (a.address) setAddress(a.address);
    const n = await freighter.getNetwork();
    setNetwork(n.network ?? null);
  }, []);
  useEffect(() => { refresh().catch(() => setInstalled(false)); }, [refresh]);

  const connect = async () => {
    const r = await freighter.requestAccess();
    if (r.error) throw new Error(String(r.error.message ?? r.error));
    setAddress(r.address);
    const n = await freighter.getNetwork();
    setNetwork(n.network ?? null);
  };
  const sign: Signer = async (txXdr, opts) => {
    const r = await freighter.signTransaction(txXdr, { networkPassphrase: opts?.networkPassphrase, address: opts?.address ?? address ?? undefined });
    if (r.error) throw new Error(String(r.error.message ?? r.error));
    return { signedTxXdr: r.signedTxXdr, signerAddress: r.signerAddress };
  };
  const signMessage = async (message: string) => {
    const r = await freighter.signMessage(message, { address: address ?? undefined });
    if (r.error) throw new Error(String(r.error.message ?? r.error));
    const s = r.signedMessage as unknown;
    if (typeof s === "string") return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
    return new Uint8Array(s as ArrayLike<number>);
  };
  return (
    <Ctx.Provider value={{ address, network, installed, connect, disconnect: () => setAddress(null), sign, signMessage }}>
      {children}
    </Ctx.Provider>
  );
}

export const useWallet = () => useContext(Ctx)!;
