// Talking to Soroban: the vault through the SDK's typed contract client (its
// spec is read from the chain), and the mUSDC token / faucet by hand.
import { Buffer } from "buffer";
import {
  Address, Asset, BASE_FEE, Contract, Operation, TransactionBuilder, contract, nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config";

export type Signer = (xdr: string, opts?: { networkPassphrase?: string; address?: string }) => Promise<{ signedTxXdr: string; signerAddress?: string }>;

let server: rpc.Server | null = null;
export const rpcServer = (c: Config) => (server ??= new rpc.Server(c.STELLAR_RPC_URL));

const clients = new Map<string, Promise<contract.Client>>();
/** The vault's typed client; `publicKey` + `signTransaction` for writes. */
export function vault(c: Config, id: string, publicKey?: string, signTransaction?: Signer) {
  const key = `${id}|${publicKey ?? ""}`;
  if (!clients.has(key)) {
    clients.set(key, contract.Client.from({ contractId: id, networkPassphrase: c.STELLAR_NETWORK_PASSPHRASE, rpcUrl: c.STELLAR_RPC_URL,
      publicKey, signTransaction: signTransaction as never }));
  }
  return clients.get(key)!;
}

const unwrap = (r: unknown) => (r && typeof (r as { unwrap?: unknown }).unwrap === "function" ? (r as { unwrap: () => unknown }).unwrap() : r);

/** Read-only vault call (simulated). */
export async function read<T = unknown>(c: Config, id: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const client = (await vault(c, id)) as unknown as Record<string, (a?: unknown) => Promise<{ result: unknown }>>;
  const tx = await client[fn](Object.keys(args).length ? args : undefined);
  return unwrap(tx.result) as T;
}

/** A vault call signed by the wallet (deposit, withdraw, deposit_note, …). */
export async function write<T = unknown>(c: Config, id: string, publicKey: string, sign: Signer, fn: string, args: Record<string, unknown>): Promise<T> {
  const client = (await vault(c, id, publicKey, sign)) as unknown as Record<string, (a?: unknown) => Promise<contract.AssembledTransaction<unknown>>>;
  const tx = await client[fn](args);
  const sent = await tx.signAndSend();
  return unwrap(sent.result) as T;
}

/** Simulates any contract call (for the token, which has no wasm spec). */
export async function simulate(c: Config, contractId: string, method: string, args: xdr.ScVal[]) {
  const source = await rpcServer(c).getAccount(c.RELAYER_ADDRESS);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: c.STELLAR_NETWORK_PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(30).build();
  const sim = await rpcServer(c).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

/**
 * Builds, signs (wallet) and submits one operation; waits for the result.
 * Contract calls are simulated first (prepareTransaction adds their footprint
 * and resource fee); classic operations such as a trustline can't be
 * simulated and are sent as they are.
 */
export async function submit(c: Config, publicKey: string, sign: Signer, op: xdr.Operation) {
  const s = rpcServer(c);
  const source = await s.getAccount(publicKey);
  // stellar-sdk 17: the operation body is a plain object with a `type` tag.
  const isContractCall = (op as unknown as { body: { type: string } }).body.type === "invokeHostFunction";
  let tx = new TransactionBuilder(source, { fee: isContractCall ? BASE_FEE : "1000", networkPassphrase: c.STELLAR_NETWORK_PASSPHRASE }).addOperation(op).setTimeout(60).build();
  if (isContractCall) tx = await s.prepareTransaction(tx);
  const { signedTxXdr } = await sign(tx.toXDR(), { networkPassphrase: c.STELLAR_NETWORK_PASSPHRASE, address: publicKey });
  const sent = await s.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, c.STELLAR_NETWORK_PASSPHRASE));
  if (sent.status === "ERROR") throw new Error(`submit failed: ${sent.errorResult?.toXDR("base64") ?? "rejected"}`);
  for (let i = 0; i < 40; i++) {
    const r = await s.getTransaction(sent.hash);
    if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: sent.hash, value: r.returnValue ? scValToNative(r.returnValue) : undefined };
    if (r.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`transaction ${sent.hash.slice(0, 10)}… failed`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("timed out waiting for the transaction");
}

// ── mUSDC ───────────────────────────────────────────────────────────────────
export const tokenBalance = async (c: Config, who: string) =>
  BigInt((await simulate(c, c.COLLATERAL_SAC, "balance", [new Address(who).toScVal()])) ?? 0);

export async function hasTrustline(c: Config, who: string) {
  const r = await fetch(`${c.HORIZON_URL}/accounts/${who}`);
  if (!r.ok) return { exists: false, line: false };
  const a = await r.json();
  return { exists: true, line: a.balances.some((b: { asset_code?: string; asset_issuer?: string }) => b.asset_code === c.MUSDC_CODE && b.asset_issuer === c.MUSDC_ISSUER) };
}

export const addTrustline = (c: Config, who: string, sign: Signer) =>
  submit(c, who, sign, Operation.changeTrust({ asset: new Asset(c.MUSDC_CODE, c.MUSDC_ISSUER) }));

export const mintFromFaucet = (c: Config, who: string, sign: Signer, amount: bigint) =>
  submit(c, who, sign, new Contract(c.MUSDC_FAUCET_ID).call("mint", new Address(who).toScVal(), nativeToScVal(amount, { type: "i128" })));

export { Buffer };
