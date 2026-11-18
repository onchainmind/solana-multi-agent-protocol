#!/usr/bin/env node
/**
 * Generate a FRESH deploy keypair for the main program (public-repo flow).
 *
 * The public bundle intentionally does NOT contain the program deploy
 * keypair (committing it would let anyone else deploy at your program
 * address first). This script creates your own keypair and tells you the
 * two follow-up steps.
 *
 * Usage:
 *   node scripts/new-program-keypair.js
 *
 * Then:
 *   1. anchor keys sync        (rewrites declare_id! + Anchor.toml + IDL)
 *   2. update PROGRAM_ID in sdk/src/config.ts to the printed address
 *   3. anchor build && anchor deploy ...
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const out = path.join(__dirname, "..", ".keys", "cypher.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) {
  console.error(`refusing to overwrite existing ${out} — delete it first if you are sure`);
  process.exit(1);
}
const solanaKeygen = process.platform === "win32" ? "solana-keygen.exe" : "solana-keygen";
const res = spawnSync(solanaKeygen, ["new", "--no-bip39-passphrase", "-o", out], {
  stdio: "inherit",
  shell: false,
});
if (res.error || res.status !== 0) {
  console.error("Failed to generate keypair with solana-keygen");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(out, "utf8"));
// print the public key without pulling web3.js: base58-encode 32 bytes
const bytes = Buffer.from(raw.slice(32, 64));
const alpha = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = BigInt("0x" + bytes.toString("hex"));
let s = "";
while (n > 0n) {
  s = alpha[Number(n % 58n)] + s;
  n /= 58n;
}
console.log("\nprogram keypair:", out);
console.log("PROGRAM ID     :", s);
console.log("\nnext steps:");
console.log("  cp", out, "programs/cypher/cypher-keypair.json");
console.log("  anchor keys sync");
console.log("  # then set PROGRAM_ID in sdk/src/config.ts to", s);
