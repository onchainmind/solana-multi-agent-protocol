#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Solana Multi-Agent Protocol: Mainnet / Devnet Deployment Orchestrator
# ==============================================================================

CLUSTER="${1:-devnet}"
KEYPAIR_PATH="${2:-programs/cypher/deploy-keypair.json}"

echo "=========================================================="
echo "Solana Multi-Agent Protocol: Contract Deployment Tool"
echo "Target Cluster : ${CLUSTER}"
echo "Keypair Target : ${KEYPAIR_PATH}"
echo "=========================================================="

# 1. Check prerequisites
command -v solana >/dev/null 2>&1 || { echo "[ERROR] 'solana' CLI is required. Install from https://docs.anza.xyz"; exit 1; }
command -v anchor >/dev/null 2>&1 || { echo "[ERROR] 'anchor' CLI is required. Install Anchor 0.31.1"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "[ERROR] 'node' is required. Install Node.js v20+"; exit 1; }

# 2. Keypair generation or verification
if [ ! -f "${KEYPAIR_PATH}" ]; then
    echo "[INFO] Deployment keypair not found at ${KEYPAIR_PATH}. Generating fresh keypair..."
    mkdir -p "$(dirname "${KEYPAIR_PATH}")"
    solana-keygen new --no-bip39-passphrase -s --outfile "${KEYPAIR_PATH}"
fi

PROGRAM_ID=$(solana address -k "${KEYPAIR_PATH}")
echo "[SUCCESS] Target Program ID: ${PROGRAM_ID}"

# 3. Synchronize Program ID across codebase
echo "[INFO] Synchronizing Program ID across Anchor.toml, lib.rs, SDK, and configuration..."
node scripts/set-program-id.js "${PROGRAM_ID}"

# 4. Compile verifiable binary
echo "[INFO] Compiling Anchor smart contract..."
anchor build

# 5. Check deployer balance
RPC_URL="https://api.${CLUSTER}.solana.com"
BALANCE=$(solana balance -u "${RPC_URL}" || echo "0 SOL")
echo "[INFO] Current Deployer Balance on ${CLUSTER}: ${BALANCE}"

# 6. Deploy program
echo "[ACTION] Deploying bytecode to Solana ${CLUSTER}..."
solana program deploy \
    --url "${RPC_URL}" \
    --program-id "${KEYPAIR_PATH}" \
    target/deploy/cypher.so

echo "=========================================================="
echo "[DEPLOYMENT COMPLETE]"
echo "Program Address  : ${PROGRAM_ID}"
echo "Solana Explorer  : https://explorer.solana.com/address/${PROGRAM_ID}?cluster=${CLUSTER}"
echo "=========================================================="
