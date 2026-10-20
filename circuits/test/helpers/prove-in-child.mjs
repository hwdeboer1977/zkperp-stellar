// Forked by test/fork.test.mjs: proves and verifies a cancel_limit proof in a
// child process, as the keeper / oracle servers run their loops (step 14).
import { proveCancelLimit, limitCommitment } from "../../lib/limits.mjs";
import { ownerHashOf } from "../../lib/notes.mjs";
import { verify } from "../../lib/private.mjs";
const o = { isLong: true, size: 1000n, collateral: 100n, limitPrice: 5n, ownerHash: await ownerHashOf(3n), orderSalt: 9n };
const c = await proveCancelLimit({ o, ownerSecret: 3n });
process.send({ ok: await verify("cancel_limit", c.proof, c.publicSignals), order: c.soroban.order === (await limitCommitment(o)).toString() });
process.exit(0);
