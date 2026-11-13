# Trident Fuzzing Framework for Cypher (Ackee Blockchain)

This directory contains the state-machine and invariant-based fuzzing test suite powered by [Trident](https://github.com/Ackee-Blockchain/trident), the official Solana smart contract fuzz testing framework developed by **Ackee Blockchain** and funded by the **Solana Foundation**.

---

## 1. Verified Protocol Invariants

The Trident fuzzer runs randomized, multi-step instruction sequences to verify that no combination of transaction interleaving can break core protocol invariants:

1. **Solvency & Non-Custodial Integrity**:
   - `Total Vault SOL + Staked mSOL >= Total User Deposited Assets`
   - User withdrawals can **never** exceed net deposited collateral.
2. **Authority Immutability**:
   - Position PDA ownership (`["position", owner]`) cannot be mutated or claimed by any external caller.
3. **Deterministic Slippage Invariant**:
   - On-chain trade execution strictly enforces minimum token output based on real-time Pyth oracle pricing minus user-configured slippage: `out >= expected * (10,000 - slippageBps) / 10,000`.

---

## 2. Running Trident Fuzzing

### Method A: Via Official Trident Docker Container (Recommended & Cross-Platform)
Ackee Blockchain maintains pre-built Docker containers with Honggfuzz and LLVM sanitizers:

```bash
cd agent-cipher

# Run Honggfuzz state fuzzing on fuzz_0 target
docker run --rm -v $(pwd):/workspace ackeeblockchain/trident:latest trident fuzz run fuzz_0
```

### Method B: Via Trident CLI (Linux / macOS / WSL)
Prerequisites:
```bash
cargo install trident-cli
```

Execute fuzzing run:
```bash
cd agent-cipher
trident fuzz run fuzz_0
```

---

## 3. GitHub Actions Continuous Fuzzing Integration

Trident is integrated into continuous integration via [`.github/workflows/trident-fuzz.yml`](../../.github/workflows/trident-fuzz.yml):
```yaml
name: Trident Invariant Fuzzing
on: [push, pull_request]
jobs:
  trident-fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Trident Invariant Fuzz
        run: docker run --rm -v $(pwd)/agent-cipher:/workspace ackeeblockchain/trident:latest trident fuzz run fuzz_0
```

---

## 4. Formal Fuzzing Audit Report

The complete 21-page formal fuzzing audit report is published in:
- PDF Report: [`audits/reports/09-Report-Trident-Fuzz.pdf`](../audits/reports/09-Report-Trident-Fuzz.pdf)
- Markdown Summary: [`audits/trident-fuzz-report.md`](../audits/trident-fuzz-report.md)

