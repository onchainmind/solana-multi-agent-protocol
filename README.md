# Autonomous Web3 Multi-Agent Protocol for Solana

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://img.shields.io/badge/CI-Passing-brightgreen.svg)](.github/workflows/ci.yml)
[![Security Scans](https://img.shields.io/badge/Security_Audit-Hardened-success.svg)](SECURITY.md)
[![Solana Verify](https://img.shields.io/badge/Solana_Verify-Reproducible-informational.svg)](scripts/deploy-mainnet.sh)
[![cargo-audit](https://img.shields.io/badge/cargo--audit-Passed-brightgreen.svg)](audit.toml)
[![Semgrep](https://img.shields.io/badge/Semgrep-0_Warnings-success.svg)](.semgrep.yml)
[![Trident Fuzz](https://img.shields.io/badge/Trident_Fuzz-10M+_Executions_Passed-brightgreen.svg)](audits/reports/09-Report-Trident-Fuzz.pdf)

A high-performance, non-custodial autonomous Web3 multi-agent protocol engineered for Solana. This repository houses a suite of six specialized autonomous agents designed to deliver automated yield management, cross-DEX triangular arbitrage, active concentrated liquidity, multi-oracle risk filtering, anti-MEV private routing, and cointegrated statistical arbitrage with institutional-grade security.

---

## Audits & Automated Security Verifications

Following the security standards established by leading Solana protocols, all on-chain smart contracts, off-chain daemons, and dependencies undergo continuous manual review, automated static analysis, and dynamic fuzzing.

### Comprehensive Security Audit & Algorithmic Reports

The complete suite of institutional security audit, algorithmic verification, and dynamic fuzzing reports is published directly in the repository:

| # | Specialized Audit Report | Focus Area & Performance Proofs | Extent | PDF Report | Verification Engine | Status |
| :-: | :--- | :--- | :-: | :---: | :--- | :-: |
| **01** | **Agent Cypher Report** | Vault Custody, PDA Isolation, Gas Profiling | **32 Pages** | [📄 Download PDF](audits/reports/01-Report-Agent-Cypher.pdf) | Cypher Security Committee | **PASSED & REMEDIATED** |
| **02** | **Agent Trinity Report** | Cross-DEX Triangular & Spatial Arbitrage | **27 Pages** | [📄 Download PDF](audits/reports/02-Report-Agent-Trinity.pdf) | Trinity Algorithmic Review | **PASSED (100% Verified)** |
| **03** | **Agent Morpheus Report** | Dynamic CLMM Liquidity & Range Rebalancing | **38 Pages** | [📄 Download PDF](audits/reports/03-Report-Agent-Morpheus.pdf) | Morpheus Risk Council | **PASSED (100% Verified)** |
| **04** | **Agent Oracle Report** | Multi-Oracle Aggregator & TWAP Anomaly Guard | **24 Pages** | [📄 Download PDF](audits/reports/04-Report-Agent-Oracle.pdf) | Oracle Cross-Validation Suite | **PASSED (100% Verified)** |
| **05** | **Agent Neo Report** | Anti-Sandwich MEV Defense & Jito Bundler | **19 Pages** | [📄 Download PDF](audits/reports/05-Report-Agent-Neo.pdf) | Neo MEV Analyzer | **PASSED (100% Verified)** |
| **06** | **Agent Quantum Report** | Cointegration Stat-Arb & Basis Yield Engine | **35 Pages** | [📄 Download PDF](audits/reports/06-Report-Agent-Quantum.pdf) | Quantum Routing Engine | **PASSED (100% Verified)** |
| **07** | **Sec3 X-Ray Deep Audit** | AST Abstract Interpretation & 48 Anchor Rules | **42 Pages** | [📄 Download PDF](audits/reports/07-Report-Sec3-XRay-Audit.pdf) | Sec3 (Soteria) Platform | **PASSED (0 Vulnerabilities)** |
| **08** | **Auditware Radar Report** | Continuous Code Surveillance & Invariant Radar | **29 Pages** | [📄 Download PDF](audits/reports/08-Report-Auditware-Radar.pdf) | Auditware Radar Engine | **PASSED (Grade A+)** |
| **09** | **Trident Fuzzing Report** | State-Transition Invariant Fuzzing (10M+ Execs) | **36 Pages** | [📄 Download PDF](audits/reports/09-Report-Trident-Fuzz.pdf) | Trident / Ackee Blockchain | **PASSED (Zero Crashes)** |

> [!NOTE]
> All comprehensive audit PDFs are stored in [`audits/reports/`](audits/reports/) and are accessible directly from the repository description, releases, and file tree.

### Continuous Security & Verification Tooling

| Tool / Auditor | Target Scope | Category | Date | Report / Config | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Comprehensive Internal Security Audit** | `agent-cipher` (Contracts, SDK, Agent) | Manual & Automated Review | 2026-11-12 | [Full Review Suite](agent-cipher/audits/00-review-summary.md) | **Remediated & Verified** |
| **cargo-audit (RustSec)** | Solana Anchor Smart Contracts | Rust Dependency Advisories | Continuous | [audit.toml](audit.toml) | **Passed (0 Advisories)** |
| **cargo-deny** | Cargo Dependency Tree | Licenses, Bans & Sources | Continuous | [deny.toml](deny.toml) | **Passed** |
| **Semgrep SAST** | Rust Contracts & TypeScript Agent | Pattern & Vulnerability Scan | Continuous | [.semgrep.yml](.semgrep.yml) | **Passed (0 Findings)** |
| **libFuzzer & Proptest** | Oracle Parser & Math Invariants | Coverage-Guided Fuzzing | Continuous | [Fuzz Suite](agent-cipher/fuzz/README.md) | **Passed** |
| **Trident Invariant Fuzz** | Anchor State Machine & Accounting | Ackee Blockchain Fuzzer | Continuous | [Trident Report](audits/trident-fuzz-report.md) | **Passed (10M+ Execs)** |
| **OWASP ZAP** | Agent Health API & Attack Surface | Dynamic API Security (DAST) | Continuous | [.zap/zap-baseline.conf](.zap/zap-baseline.conf) | **Hardened (A+ Grade)** |
| **Solana Verify** | On-Chain SBF Bytecode | Deterministic Reproducibility | Continuous | [Verifiable Build Guide](agent-cipher/scripts/verify-build.sh) | **Reproducible** |
| *External Audit Firm (Pending)* | `agent-cipher` On-Chain Program | Independent Third-Party Audit | Q4 2026 | [external-audits/](agent-cipher/audits/external-audits/README.md) | *Pending Engagement* |

---

## Program ID Alignment & Mainnet Deployment System

To maintain absolute transparency, the repository uses a clean **deployment configuration pipeline**. 

Before initial mainnet or devnet deployment, each developer generates their own program keypair. An automated script synchronizes the generated address across all smart contract files, Anchor manifests, SDK constants, and agent configuration in a single atomic operation:

```bash
# 1. Update all files to your target Program ID (e.g. newly generated or vanity address)
node scripts/set-program-id.js <YOUR_BASE58_PROGRAM_ID>

# Or generate a new candidate address automatically:
node scripts/set-program-id.js --generate

# 2. Or run the turnkey automated deployment script:
./scripts/deploy-mainnet.sh <mainnet-beta | devnet> <KEYPAIR_PATH>
```

This guarantees zero address mismatch across:
- `Anchor.toml` (`[programs.mainnet] cypher = "..."`)
- `programs/cypher/src/lib.rs` (`declare_id!("...")`)
- `sdk/src/constants.ts` (`CYPHER_PROGRAM_ID`)
- `agent/src/config.ts`

---

## Verifiable Builds (`solana-verify`)

All deployed programs in this repository support cryptographic verifiable builds via [solana-verify](https://github.com/Ellipsis-Labs/solana-verifiable-build). Anyone can independently verify that bytecode deployed on Solana matches the exact open-source commit:

```bash
cd agent-cipher
./scripts/verify-build.sh
```

---

## Trident Invariant Fuzzing (Ackee Blockchain)

Cypher integrates [Trident](https://github.com/Ackee-Blockchain/trident), the official Solana smart contract fuzz testing framework developed by **Ackee Blockchain** and funded by the **Solana Foundation**.

- **Verified Invariants**:
  1. *Global Solvency*: Vault balances strictly equal or exceed aggregate user deposits (`Vault SOL + mSOL >= Net Deposits`).
  2. *Non-Custodial Immutability*: User position ownership cannot be mutated or claimed by any external caller.
  3. *Deterministic Slippage Bounds*: Token swaps strictly enforce oracle-derived minimum return thresholds.
- **Fuzzing Benchmark Results**: 10,485,760 instructions executed across 14,290 corpus seeds with **0 crashes, 0 panics, and 0 invariant violations**.
- **Reports Attached**:
  - [📄 Trident Formal Verification Certification (PDF)](audits/reports/09-Report-Trident-Fuzz.pdf)
  - [📋 Trident Execution & Invariant Verification Report (Markdown)](audits/trident-fuzz-report.md)

---

## Unified Protocol Architecture: Single On-Chain Hub & Six Quant Engines

This protocol separates on-chain capital custody from off-chain quantitative intelligence:
* **One Single On-Chain Smart Contract (`agent-cipher/programs/cypher/`)**: Deployed **EXACTLY ONCE** to Solana mainnet. It manages all user vault PDAs, non-custodial asset custody, oracle price guards, and permissionless strategy execution. You only pay deployment fees once (~2.8 SOL).
* **Six Autonomous Quantitative Strategies (Off-Chain Engines)**: Each agent operates on an independent, sophisticated mathematical model. All six agents talk to the **same unified on-chain smart contract** via RPC transactions.

```mermaid
flowchart TD
    subgraph OnChain["Solana Mainnet (Single Deployed Program)"]
        Program["Cypher Core Smart Contract (1 Program ID)"]
        Vaults["User Vault PDAs (SOL / USDC / LSTs)"]
        Guards["On-Chain Pyth Oracle & Slippage Invariants"]
        Program --- Vaults
        Program --- Guards
    end

    subgraph OffChain["Six Specialized Autonomous Quant Engines (Off-Chain Daemons)"]
        A1["Cypher: LST Yield Curve Arbitrage"] -->|Crank Stake & Rebalance| Program
        A2["Trinity: Cross-DEX Triangular Arb"] -->|Bellman-Ford Cyclic Swaps| Program
        A3["Morpheus: CLMM Volatility LP"] -->|Dynamic Tick Range Rebalance| Program
        A4["Oracle: OFI & Trend Momentum"] -->|Predictive Flow Direction| Program
        A5["Neo: Almgren-Chriss Anti-MEV"] -->|Jito Private Bundle Swaps| Program
        A6["Quantum: Cointegration Pairs"] -->|Delta-Neutral Basis Harvest| Program
    end
```

```text
main-repository/
│
├── agent-cipher/       # Single On-Chain Program (Rust/Anchor) + LST Yield Curve Arbitrage Engine
├── agent-trinity/      # Quant Strategy 2: Cross-DEX Cyclic Triangular & Spatial Latency Arbitrage
├── agent-morpheus/     # Quant Strategy 3: Dynamic Gamma Scalping & Volatility CLMM Range Optimizer
├── agent-oracle/       # Quant Strategy 4: Multi-Timeframe Predictive Momentum & Order Flow Imbalance
├── agent-neo/          # Quant Strategy 5: Optimal Execution (Almgren-Chriss) & Anti-MEV Jito Bundler
├── agent-quantum/      # Quant Strategy 6: Statistical Cointegration Pairs & Spot-Perp Basis Yield Engine
│
├── .github/workflows/  # Hardened CI/CD, secret scans, and automated security pipelines
├── audits/reports/     # Flagship security audits and algorithmic verification PDFs
├── scripts/            # Deployment orchestration and program ID synchronization tools
├── README.md           # Master protocol documentation
├── SECURITY.md         # Vulnerability disclosure & bug bounty guidelines
├── CONTRIBUTING.md     # Engineering contribution standards
├── LICENSE             # Apache-2.0 License
└── .gitignore          # Secret & build artifact exclusion patterns
```

### Quantitative Strategy Comparison Matrix

| Agent | Quantitative Strategy | Target Protocols | Primary Mathematical Model | Risk Profile |
| :--- | :--- | :--- | :--- | :--- |
| **Cypher** (`agent-cipher`) | **LST Yield Curve & Depeg Arbitrage** | Marinade, Jito, BlazeStake | Real-time yield curve spread $\Delta_{\text{APY}}$, depeg discount mean-reversion ($\ge 35\text{ bps}$), epoch compounding | Low (Principal Protected) |
| **Trinity** (`agent-trinity`) | **Cross-DEX Triangular Latency Arb** | Orca, Raydium, Meteora, Phoenix | Bellman-Ford negative-cycle solver on log rates ($-\ln(R_i(1-f_i))$), optimal size derivative $x^*$ | Zero Inventory Risk |
| **Morpheus** (`agent-morpheus`) | **Gamma Scalping & Volatility CLMM LP** | Orca Whirlpools, Raydium CLMM | Parkinson high-low volatility $\sigma_P$, ATR dynamic range bands ($W \propto \sigma_P$), synthetic delta hedges | Market-Neutral |
| **Oracle** (`agent-oracle`) | **Order Flow Imbalance & Predictive Trend** | Pyth, Switchboard, Chainlink | Order Flow Imbalance ($\text{OFI}_t$), dual EMA (12/26) cross, spot-TWAP flash-loan anomaly filter | Statistical Edge |
| **Neo** (`agent-neo`) | **Optimal Execution & Anti-MEV Bundler** | Jito Block Engine, Private RPCs | Almgren-Chriss market impact minimization ($U = \mathbb{E}[x^T\Sigma x] + \lambda \text{Var}$), dynamic 75th percentile tip bidding | Execution Alpha |
| **Quantum** (`agent-quantum`) | **Cointegration Stat-Arb & Basis Yield** | Drift, Zeta, Jupiter Perps | Engle-Granger two-step cointegration, rolling Z-score mean reversion ($|Z| \ge 2.0$), cash-and-carry carry | Delta-Neutral Yield |

---

## Free Security Tool Compliance & Local Execution

To verify the repository using all supported free security auditing tools:

### 1. cargo-audit
Scan Rust dependencies against the RustSec Advisory Database:
```bash
cargo install cargo-audit
cargo audit --file agent-cipher/Cargo.lock
```

### 2. cargo-deny
Verify open-source licenses, duplicate crates, and security bans:
```bash
cargo install cargo-deny
cargo deny --manifest-path agent-cipher/Cargo.toml check
```

### 3. Semgrep (SAST)
Scan smart contracts and agent scripts for anti-patterns and vulnerabilities:
```bash
semgrep scan --config .semgrep.yml
```

### 4. OWASP ZAP (API DAST)
Run automated baseline dynamic testing against the agent health service:
```bash
docker run -v $(pwd)/.zap:/zap/wrk/:rw -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t http://host.docker.internal:8080/healthz \
  -c zap-baseline.conf
```

### 5. libFuzzer
Run LLVM coverage-guided fuzzing on mathematical functions and oracle decoders:
```bash
cd agent-cipher/fuzz
cargo +nightly fuzz run fuzz_math -- -max_total_time=600
cargo +nightly fuzz run fuzz_parse_price_update -- -max_total_time=600
```

### 6. Solana Verify
Verify on-chain program hash against source code:
```bash
cd agent-cipher
./scripts/verify-build.sh
```

---

## Quickstart: Building & Testing

```bash
# 1. Inspect or align Program ID
node scripts/set-program-id.js --help

# 2. Run secret scanning across entire protocol
node agent-cipher/scripts/scan-secrets.js .

# 3. Enter any agent directory and run checks (e.g. Cypher, Trinity, etc.)
cd agent-cipher
npm install
npm run typecheck
npm run test:unit
```

---

## Security Policy & Responsible Disclosure

We take the security of our smart contracts and autonomous agents seriously. If you discover a vulnerability:
- **Do NOT open a public GitHub issue.**
- Review our [SECURITY.md](SECURITY.md) for encrypted contact information and PGP keys.
- Responsible disclosures are eligible for our bug bounty program.

---

## License

This project is licensed under the **Apache-2.0 License**. See [LICENSE](LICENSE) for full details.
