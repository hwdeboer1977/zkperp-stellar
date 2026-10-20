// Prints a circuit's verification key as the vault's VerificationKey JSON arg.
import fs from "node:fs";
import { vkeyToSoroban } from "../lib/encoding.mjs";
const name = process.argv[2] ?? "open_position";
const vk = JSON.parse(fs.readFileSync(new URL(`../keys/${name}.vkey.json`, import.meta.url)));
console.log(JSON.stringify(vkeyToSoroban(vk)));
