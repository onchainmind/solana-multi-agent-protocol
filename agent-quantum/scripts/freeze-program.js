#!/usr/bin/env node
/**
 * Safe FREEZE script for Cypher program upgrade authority revocation.
 *
 * Makes the program permanently immutable by setting the upgrade authority
 * to none (--final).
 *
 * SECURITY CONTROLS:
 * - Strict base58 public key validation using @solana/web3.js PublicKey.
 * - Direct argument-array execution (spawnSync/execFileSync) with shell: false
 *   to eliminate shell injection vulnerabilities.
 * - Cluster awareness and confirmation checks.
 * - Explicit confirmation requirement before executing irreversible changes.
 *
 * Usage:
 *   node scripts/freeze-program.js --program <PROGRAM_ID> [--cluster <url|devnet|mainnet-beta>] [--execute] [--confirm FREEZE]
 */
const { PublicKey } = require("@solana/web3.js");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = argv.slice(2);
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  return {
    program: getArg("--program"),
    cluster: getArg("--cluster") || "devnet",
    execute: args.includes("--execute"),
    confirm: getArg("--confirm"),
  };
}

function validateProgramId(programStr) {
  if (!programStr || typeof programStr !== "string") {
    throw new Error("Missing --program argument.");
  }
  // Prevent shell metacharacters and validate exact Base58 public key
  if (/[;&|`$><() \t\r\n]/.test(programStr)) {
    throw new Error("Program ID contains illegal shell metacharacters or whitespace.");
  }
  try {
    const pk = new PublicKey(programStr);
    if (!PublicKey.isOnCurve(pk.toBytes())) {
      // Note: Program accounts are usually off-curve, but valid 32-byte Pubkeys
    }
    return pk.toBase58();
  } catch (err) {
    throw new Error(`Invalid Solana public key '${programStr}': ${err.message}`);
  }
}

function runFreeze(options = {}) {
  const program = validateProgramId(options.program);
  const cluster = options.cluster || "devnet";
  const execute = Boolean(options.execute);
  const confirm = options.confirm;

  const solanaArgs = ["program", "set-upgrade-authority", program, "--final"];
  if (cluster) {
    solanaArgs.push("--url", cluster);
  }

  if (!execute) {
    console.log("=== DRY RUN (No on-chain changes made) ===");
    console.log(`Target Program ID: ${program}`);
    console.log(`Target Cluster   : ${cluster}`);
    console.log(`Safe Command     : solana ${solanaArgs.join(" ")}`);
    console.log("\nTo execute this irreversible operation, re-run with:");
    console.log(`  node scripts/freeze-program.js --program ${program} --cluster ${cluster} --execute --confirm FREEZE`);
    return { success: true, dryRun: true, program, solanaArgs };
  }

  // Execution safeguard
  if (confirm !== "FREEZE") {
    throw new Error(
      "Safety rail: Irreversible freeze requested without explicit confirmation. Pass '--confirm FREEZE' to proceed."
    );
  }

  console.log("=== EXECUTING IRREVERSIBLE FREEZE ===");
  console.log(`Target Program ID: ${program}`);
  console.log(`Target Cluster   : ${cluster}`);

  // Safe process execution with shell: false
  const solanaBin = process.platform === "win32" ? "solana.exe" : "solana";
  const result = spawnSync(solanaBin, solanaArgs, {
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw new Error(`Failed to invoke solana CLI: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Solana CLI exited with error code ${result.status}`);
  }

  console.log(`Program ${program} is now IMMUTABLE.`);
  return { success: true, dryRun: false, program };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv);
    runFreeze(opts);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  validateProgramId,
  runFreeze,
};
