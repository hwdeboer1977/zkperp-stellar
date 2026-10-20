// Cross-check fixture for the vault's Rust tests: digests and signatures made
// here with stellar-sdk must verify in the contract.
//   node scripts/oracle-fixture.mjs ../contracts/zkperp-vault/src/fixtures/oracle.json
import fs from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { priceDigest, rotationDigest } from "../lib/oracle.mjs";

// Test keys: seeds [1;32], [2;32], [3;32], [4;32] (same as the Rust tests).
const kp = (i) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, i));
const vault = "CAFE37QAK4XXDB7DPJLFTZHT7WGIAYUA4LM6CB2NYZW6YVE3CUPPLIWE";
const report = { round: (7n << 64n) | 25181n, price: 8_214_517_000_000n, updated_at: 1_792_152_935n };
const digest = priceDigest(vault, report.round, report.price, report.updated_at);
const newKey = Buffer.from(kp(4).rawPublicKey()).toString("hex");
const rot = rotationDigest(vault, 0, 2, newKey);
fs.writeFileSync(process.argv[2], JSON.stringify({
  vault, round: report.round.toString(), price: report.price.toString(), updated_at: report.updated_at.toString(),
  digest: digest.toString("hex"),
  sig_1: Buffer.from(kp(1).sign(digest)).toString("hex"), sig_3: Buffer.from(kp(3).sign(digest)).toString("hex"),
  rotation: { epoch: 0, slot: 2, key: newKey, digest: rot.toString("hex"), sig_1: Buffer.from(kp(1).sign(rot)).toString("hex"), sig_2: Buffer.from(kp(2).sign(rot)).toString("hex") },
}, null, 2) + "\n");
console.log("oracle fixture written");
