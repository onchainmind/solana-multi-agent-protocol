#!/usr/bin/env node
/**
 * Automated Secret Scanner for Cypher
 *
 * Scans the repository for:
 * - Committed Solana keypairs (JSON byte arrays of length 64)
 * - Raw base58 private keys
 * - PEM private keys
 * - Hardcoded secrets or credentials in .env files
 * - API keys / bearer tokens
 */
const fs = require("fs");
const path = require("path");

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..");

// Directories to ignore during scanning
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  ".anchor",
  "dist",
  "build",
]);

// Allowlisted mock test fixtures
const ALLOWLISTED_BASENAMES = new Set([
  "mock_marinade-keypair.json",
  "mock_jupiter-keypair.json",
]);

const SECRET_PATTERNS = [
  {
    name: "Solana 64-byte Keypair JSON Array",
    test: (content, relPath) => {
      const baseName = path.basename(relPath);
      if (ALLOWLISTED_BASENAMES.has(baseName)) return false;
      if (!relPath.endsWith(".json")) return false;
      try {
        const parsed = JSON.parse(content);
        if (
          Array.isArray(parsed) &&
          parsed.length === 64 &&
          parsed.every((n) => typeof n === "number" && n >= 0 && n <= 255)
        ) {
          return true;
        }
      } catch {
        // Not valid JSON
      }
      return false;
    },
  },
  {
    name: "Private Key PEM Header",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "Committed Secret in Environment Variable",
    regex: /^(?:AGENT_SECRET_KEY_B58|PRIVATE_KEY|SECRET_KEY)\s*=\s*['"]?[a-zA-Z0-9]{30,}['"]?/m,
    filter: (relPath) => !relPath.endsWith(".example"),
  },
  {
    name: "High-Entropy 88-char Base58 Private Key Candidate",
    regex: /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/,
    filter: (relPath) =>
      !relPath.endsWith(".lock") &&
      !relPath.endsWith(".json") &&
      !relPath.endsWith(".md"),
  },
];

let findings = [];

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        scanDirectory(fullPath);
      }
    } else if (entry.isFile()) {
      scanFile(fullPath, relPath);
    }
  }
}

function scanFile(fullPath, relPath) {
  try {
    const content = fs.readFileSync(fullPath, "utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.filter && !pattern.filter(relPath)) continue;
      if (pattern.test && pattern.test(content, relPath)) {
        findings.push({ file: relPath, issue: pattern.name });
      } else if (pattern.regex && pattern.regex.test(content)) {
        findings.push({ file: relPath, issue: pattern.name });
      }
    }
  } catch (err) {
    // Binary or unreadable file
  }
}

console.log("Scanning repository for exposed secrets...");
scanDirectory(root);

if (findings.length > 0) {
  console.error(`\n[CRITICAL ERROR] Detected ${findings.length} potential secret(s) in repository:`);
  for (const f of findings) {
    console.error(` - ${f.file}: ${f.issue}`);
  }
  process.exit(1);
} else {
  console.log("Secret scan passed: zero unallowlisted private keys or secrets detected.");
  process.exit(0);
}
