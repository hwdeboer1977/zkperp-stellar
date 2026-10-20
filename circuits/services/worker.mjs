// Runs a service loop (keeper or oracle signer) in a child process forked by
// its server, so the HTTP server stays responsive while the loop blocks on
// stellar CLI calls. (A child process, not a worker thread: snarkjs starts its
// own worker threads and must run on a main thread.) Sends
// { type: "snapshot", state } every 2 s and { type: "signed", round, entry }
// for each new oracle signature, over IPC.
//   argv: <keeper|oracle> <n>
const [kind, nArg] = process.argv.slice(2);
const n = Number(nArg);
const parentPort = { postMessage: (m) => process.send?.(m) };
process.on("disconnect", () => process.exit(0));
const toPlain = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
try {
  if (kind === "keeper") {
    const { startKeeper } = await import("../lib/keeper-service.mjs");
    const keeper = await startKeeper(n);
    const post = () => { try { parentPort.postMessage({ type: "snapshot", state: toPlain(keeper.snapshot()) }); } catch {} };
    post();
    setInterval(post, 2000);
  } else {
    const { startSigner } = await import("../lib/oracle-service.mjs");
    const signer = await startSigner(n, { onSigned: (round, entry) => parentPort.postMessage({ type: "signed", round: round.toString(), entry: toPlain(entry) }) });
    parentPort.postMessage({ type: "port", port: signer.port });
    setInterval(() => parentPort.postMessage({ type: "snapshot", state: toPlain(signer.health) }), 2000);
  }
} catch (e) {
  parentPort.postMessage({ type: "fatal", message: e.message });
}
