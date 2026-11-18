#!/usr/bin/env node
/**
 * Program ID Alignment & Deployment Manager for Solana Multi-Agent Protocol
 * Zero External Dependencies — Runs natively on any Node.js environment.
 *
 * Usage:
 *   node scripts/set-program-id.js <NEW_PROGRAM_ID>
 *   node scripts/set-program-id.js --generate
 *
 * Atomically updates declared Program IDs across:
 * - Anchor.toml
 * - programs/cypher/src/lib.rs
 * - sdk/src/constants.ts
 * - agent/src/config.ts
 * - .env.example
 * - README.md
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isInsideAgentCipher = fs.existsSync(path.join(__dirname, '..', 'programs', 'cypher'));
const rootDir = isInsideAgentCipher ? path.resolve(__dirname, '..', '..') : path.resolve(__dirname, '..');
const agentCipherDir = isInsideAgentCipher ? path.resolve(__dirname, '..') : path.join(rootDir, 'agent-cipher');

// Base58 validation regex (Solana addresses are 32-44 base58 chars, no 0, O, I, l)
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidPublicKey(keyStr) {
  return typeof keyStr === 'string' && BASE58_REGEX.test(keyStr);
}

// Simple base58 encoder for generating random address fixture
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(buffer) {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    str += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]];
  }
  return str;
}

let targetProgramId = process.argv[2];

if (!targetProgramId || targetProgramId === '--help') {
  console.log(`
Solana Multi-Agent Protocol: Program ID Configurator
=====================================================
Usage:
  node scripts/set-program-id.js <NEW_BASE58_PROGRAM_ID>
  node scripts/set-program-id.js --generate

Examples:
  node scripts/set-program-id.js 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin
  node scripts/set-program-id.js --generate
`);
  process.exit(0);
}

if (targetProgramId === '--generate') {
  const randomBytes = crypto.randomBytes(32);
  targetProgramId = encodeBase58(randomBytes);
  console.log(`Generated candidate Program ID: ${targetProgramId}`);
  console.log(`NOTE: For live mainnet deployments, use 'solana-keygen new -o deploy-keypair.json'`);
}

if (!isValidPublicKey(targetProgramId)) {
  console.error(`[ERROR] '${targetProgramId}' is not a valid Solana Base58 public key.`);
  console.error(`Expected 32-44 characters in base58 alphabet (1-9, A-H, J-N, P-Z, a-k, m-z).`);
  process.exit(1);
}

console.log(`\nConfiguring Program ID across protocol repositories:`);
console.log(`Target Address: ${targetProgramId}\n`);

// Regex to match existing declared program ID (standard 32-44 base58 chars)
const OLD_ID_PATTERN = /26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC/g;

const allAgentDirs = [
  'agent-cipher',
  'agent-trinity',
  'agent-morpheus',
  'agent-oracle',
  'agent-neo',
  'agent-quantum',
];

const filesToUpdate = [
  path.join(agentCipherDir, 'Anchor.toml'),
  path.join(agentCipherDir, 'programs', 'cypher', 'src', 'lib.rs'),
  path.join(rootDir, 'README.md'),
];

for (const agentDir of allAgentDirs) {
  const fullAgentPath = path.join(rootDir, agentDir);
  filesToUpdate.push(path.join(fullAgentPath, 'sdk', 'src', 'constants.ts'));
  filesToUpdate.push(path.join(fullAgentPath, 'agent', 'src', 'config.ts'));
  filesToUpdate.push(path.join(fullAgentPath, '.env.example'));
  filesToUpdate.push(path.join(fullAgentPath, 'README.md'));
}

let totalReplacements = 0;

for (const filePath of filesToUpdate) {
  if (!fs.existsSync(filePath)) {
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  const matches = content.match(OLD_ID_PATTERN);
  if (matches) {
    content = content.replace(OLD_ID_PATTERN, targetProgramId);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  [UPDATED] ${path.relative(rootDir, filePath)} (${matches.length} occurrence(s) updated)`);
    totalReplacements += matches.length;
  } else {
    let modified = false;
    if (filePath.endsWith('lib.rs')) {
      const declareRegex = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\);/;
      if (declareRegex.test(content)) {
        content = content.replace(declareRegex, `declare_id!("${targetProgramId}");`);
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`  [UPDATED] ${path.relative(rootDir, filePath)} (declare_id aligned)`);
        modified = true;
        totalReplacements++;
      }
    }
    if (!modified) {
      console.log(`  [UNCHANGED] ${path.relative(rootDir, filePath)}`);
    }
  }
}

console.log(`\nCompleted! Total occurrences updated: ${totalReplacements}`);
console.log(`\nNext Steps:`);
console.log(`1. Run 'anchor build' inside agent-cipher/ to compile with the new Program ID.`);
console.log(`2. Deploy the program to Solana Devnet or Mainnet:`);
console.log(`   solana program deploy target/deploy/cypher.so --program-id <KEYPAIR_PATH>\n`);
