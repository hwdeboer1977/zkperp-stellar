import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

test("proving works in a forked child process (the servers' architecture)", async () => {
  const child = fork(fileURLToPath(new URL("./helpers/prove-in-child.mjs", import.meta.url)), [], { stdio: "pipe" });
  const msg = await new Promise((resolve, reject) => {
    child.on("message", resolve);
    child.on("exit", (code) => code && reject(new Error(`child exited ${code}`)));
  });
  assert.deepEqual(msg, { ok: true, order: true });
});
