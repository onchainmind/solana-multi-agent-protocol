#!/usr/bin/env bash
# Verifiable build and on-chain verification script for Cypher Anchor program.
# Uses solana-verify (Ellipsis Labs) or anchor build --verifiable.

set -euo pipefail

PROGRAM_ID="${1:-26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC}"
CLUSTER="${2:-mainnet}"

echo "=========================================================="
echo "Cypher Program Verifiable Build & Verification Tool"
echo "Target Program ID: ${PROGRAM_ID}"
echo "Cluster:           ${CLUSTER}"
echo "=========================================================="

if ! command -v solana-verify &> /dev/null; then
    echo "[!] solana-verify CLI not found in PATH."
    echo "    Installing solana-verify via cargo..."
    cargo install solana-verify
fi

echo "[*] Step 1: Building verifiable program binary inside Docker container..."
solana-verify build --library-name cypher

echo "[*] Step 2: Computing cryptographic SHA-256 executable hash..."
solana-verify get-executable-hash target/deploy/cypher.so

echo ""
echo "[*] Step 3: Verifying against on-chain bytecode..."
echo "To verify against a live cluster deployment, run:"
echo "  solana-verify verify-from-repo --remote -u ${CLUSTER} --program-id ${PROGRAM_ID} <GITHUB_REPO_URL>"
echo "=========================================================="

