#!/usr/bin/env node
/**
 * Prepare program keypairs for a local build/test cycle.
 *
 * * Mock programs: copy the committed TEST-ONLY fixtures (valueless, localnet)
 *   so the build always lands at the addresses declare_id! and the SDK expect.
 * * Main program: use the local deploy keypair if one exists
 *   (tests/fixtures/cypher-keypair.json or .keys/cypher.json).
 *   In the public bundle that keypair is intentionally NOT committed —
 *   a fresh one is generated instead; run `anchor keys sync` afterwards so
 *   declare_id!, Anchor.toml and the IDL all match the new address.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");

function copy(src, dst) {
  const s = path.join(root, src);
  const d = path.join(root, dst);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  console.log(`synced ${src} -> ${dst}`);
}

// mock programs — committed test fixtures
copy("tests/fixtures/mock_marinade-keypair.json", "programs/mock-marinade/mock-marinade-keypair.json");
copy("tests/fixtures/mock_jupiter-keypair.json", "programs/mock-jupiter/mock-jupiter-keypair.json");

// main program — fixture (local dev) or fresh keypair (public clone / CI)
const fixture = path.join(root, "tests/fixtures/cypher-keypair.json");
const keys = path.join(root, ".keys/cypher.json");
const deployKp = path.join(root, "target/deploy/cypher-keypair.json");
fs.mkdirSync(path.dirname(deployKp), { recursive: true });

if (fs.existsSync(fixture)) {
  fs.copyFileSync(fixture, "programs/cypher/cypher-keypair.json");
  fs.copyFileSync(fixture, deployKp);
  console.log("synced tests/fixtures/cypher-keypair.json -> programs + target/deploy");
} else if (fs.existsSync(keys)) {
  fs.copyFileSync(keys, "programs/cypher/cypher-keypair.json");
  fs.copyFileSync(keys, deployKp);
  console.log("synced .keys/cypher.json -> programs + target/deploy");
} else {
  // Public clone / CI: generate a fresh deploy keypair, then the caller
  // runs `anchor keys sync` so declare_id!, Anchor.toml and the IDL match.
  if (!fs.existsSync(deployKp)) {
    const solanaKeygen = process.platform === "win32" ? "solana-keygen.exe" : "solana-keygen";
    spawnSync(solanaKeygen, ["new", "--no-bip39-passphrase", "--silent", "-o", deployKp], {
      cwd: root,
      stdio: "inherit",
      shell: false,
    });
    console.log("generated a FRESH target/deploy/cypher-keypair.json");
  }
  fs.copyFileSync(deployKp, path.join(root, "programs/cypher/cypher-keypair.json"));
  console.log("synced target/deploy/cypher-keypair.json -> programs/cypher/");
  console.log("NEXT: run `anchor keys sync` to align declare_id! with the new address");
}
