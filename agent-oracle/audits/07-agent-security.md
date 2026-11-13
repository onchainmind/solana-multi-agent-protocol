# Audit Report: TypeScript Agent & Off-Chain Service Security

## 1. Overview
The Cypher autonomous agent (`agent/src/index.ts`) monitors on-chain positions and submits permissionless cranks (`crank_stake` and `crank_trade`).

---

## 2. Agent Trust & Custody Model
The off-chain agent operates under a strictly **zero-trust custody model**:
- **Identity Key Scope**: The agent's keypair is solely a transaction fee payer. It does NOT possess signing authority over user positions or user vaults.
- **On-Chain Enforcement**: The smart contract independently re-evaluates all conditions on-chain:
  - Is the strategy active and unpaused?
  - Has the cycle cooldown elapsed?
  - What is the Pyth oracle price?
  - What is the exact input and minimum output?
- **Agent Compromise Invariant**: If an agent host is compromised or submits malformed transactions, the on-chain program reverts. The attacker cannot redirect funds, alter trade sizes, or withdraw user capital.

---

## 3. Discovered Vulnerabilities & Remediations

### Finding ID: CYPHER-SEC-004
### Title: Unvalidated Environment Configuration in Agent
- **Severity**: High
- **Affected File**: `agent/src/config.ts`
- **Original Issue**:
  Configuration values from environment variables (`POLL_INTERVAL_SECS`, `CRANK_TRADE_CU`, `CRANK_STAKE_CU`, `PRIORITY_FEE_MICRO_LAMPORTS`, `JUP_SLIPPAGE_BPS`) were parsed with unchecked `parseInt()`, accepting `NaN`, negative intervals, and out-of-bounds compute unit limits (> 1.4M CU). RPC URLs and public keys were unvalidated.
- **Security Impact**:
  Malformed environment settings could result in `NaN` timeouts, invalid transactions rejected by the runtime, or crash loops that halt autonomous cranks.
- **Implemented Solution**:
  1. Implemented strict parsing functions: `parseInteger`, `parseCluster`, `parseRpcUrl`, `parsePublicKey`, `parseFeedId`.
  2. Enforced bounds:
     - `pollIntervalSecs`: [1, 86400] seconds.
     - `crankTradeComputeUnits`: [10_000, 1_400_000] CU.
     - `crankStakeComputeUnits`: [10_000, 1_400_000] CU.
     - `jupiterSlippageBps`: [1, 10_000] bps.
     - `pythMaxStalenessSecs`: [1, 3600] seconds.
  3. Added unit tests in `tests/config.test.ts` covering valid, invalid, boundary, and missing parameters.
- **Verification**: Executed `npx mocha -r ts-node/register tests/config.test.ts` — 18 passing tests.
- **Status**: Fixed

---

### Finding ID: CYPHER-SEC-010
### Title: Missing Preflight Simulation in Agent Broadcast
- **Severity**: Medium
- **Affected File**: `agent/src/index.ts` (lines 344–358)
- **Original Issue**:
  The agent signed and broadcast transactions directly via `sendRawTransaction` without performing local preflight simulation (`simulateTransaction`).
- **Security Impact**:
  If a crank condition changed between scan and block inclusion (e.g., price moved past slippage or cooldown not met), the transaction was submitted to the network, wasting transaction fees on reverts and generating spurious RPC errors.
- **Implemented Solution**:
  Added explicit `simulateTransaction` check before broadcasting in `Agent.send()`. If simulation indicates an error, the agent logs the warning and aborts broadcast cleanly.
- **Status**: Fixed
