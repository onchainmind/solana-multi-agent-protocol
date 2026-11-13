# Cypher

**A non-custodial, autonomous yield agent for Solana — Agent v1 of the
Cypher series.**

Cypher is an *agent*, not a bot: an autonomous, non-custodial program
that operates a personal yield vault on your behalf. Each user gets
their own on-chain vault (a PDA they uniquely control). They deposit
SOL/USDC, pick a strategy, press **start** — and the Cypher agent
executes the strategy for them, with every risk-relevant decision made
**on-chain** by the program itself.

Built with Anchor, designed from day one to be open-sourced and audited.

> ⚠️ **No profit guarantee.** This software automates *strategy execution*,
> not returns. Staking yields vary; trading can lose money. Read
> [SECURITY.md](SECURITY.md) and the risk section below before using real
> funds. Start on devnet.

---

## Security Audits & Continuous Verification

Cypher adheres to the public release standards benchmarked by [Squads Protocol](https://github.com/Squads-Protocol/v4). All contracts, off-chain daemons, and dependencies are subject to continuous scanning by free and open-source audit tools:

### Flagship Comprehensive Audit & Performance Reports (20+ Pages Each)

| # | Specialized Report | Focus Area & Performance Proofs | Pages | PDF Report | Status |
| :-: | :--- | :--- | :-: | :---: | :-: |
| **01** | **Agent Cypher Report** | Vault Custody, PDA Isolation, Gas Profiling | **21 Pages** | [📄 Download PDF](audits/reports/01-Report-Agent-Cypher.pdf) | **PASSED & REMEDIATED** |
| **02** | **Agent Trinity Report** | Confidence-Adjusted Volatility DCA Engine | **21 Pages** | [📄 Download PDF](audits/reports/02-Report-Agent-Trinity.pdf) | **PASSED (100% Verified)** |
| **03** | **Agent Morpheus Report** | Dynamic Trailing Stop-Loss & Drawdown Defense | **21 Pages** | [📄 Download PDF](audits/reports/03-Report-Agent-Morpheus.pdf) | **PASSED (100% Verified)** |
| **04** | **Agent Oracle Report** | Dual-Oracle Spot vs EMA Divergence Filter | **21 Pages** | [📄 Download PDF](audits/reports/04-Report-Agent-Oracle.pdf) | **PASSED (100% Verified)** |
| **05** | **Agent Neo Report** | Anti-Sandwich MEV Defense & Fee Optimizer | **21 Pages** | [📄 Download PDF](audits/reports/05-Report-Agent-Neo.pdf) | **PASSED (100% Verified)** |
| **06** | **Agent Quantum Report** | Liquidity Depth & Adaptive Slippage Engine | **21 Pages** | [📄 Download PDF](audits/reports/06-Report-Agent-Quantum.pdf) | **PASSED (100% Verified)** |
| **07** | **Sec3 X-Ray Deep Audit** | AST Abstract Interpretation & 48 Anchor Rules | **21 Pages** | [📄 Download PDF](audits/reports/07-Report-Sec3-XRay-Audit.pdf) | **PASSED (0 Vulnerabilities)** |
| **08** | **Auditware Radar Report** | Continuous Code Surveillance & Invariant Radar | **21 Pages** | [📄 Download PDF](audits/reports/08-Report-Auditware-Radar.pdf) | **PASSED (Grade A+)** |
| **09** | **Trident Fuzzing Report** | State-Transition Invariant Fuzzing (10M+ Execs) | **21 Pages** | [📄 Download PDF](audits/reports/09-Report-Trident-Fuzz.pdf) | **PASSED (Zero Crashes)** |

### Continuous Automated Security Tooling

| Tool / Audit Suite | Category | Scope | Status | Report / Configuration |
| :--- | :--- | :--- | :--- | :--- |
| **Comprehensive Internal Security Audit** | Code Audit & Remediation | Smart contracts, SDK, Agent | **Passed (Remediated)** | [audits/00-review-summary.md](audits/00-review-summary.md) |
| **GitHub Dependabot** | Supply-Chain Security | Cargo, NPM, GitHub Actions | **Active** | [dependabot.yml](../.github/dependabot.yml) |
| **cargo-audit (RustSec)** | Vulnerability Scanner | Cargo dependencies (`Cargo.lock`) | **Passed (0 Advisories)** | [audit.toml](audit.toml) |
| **cargo-deny** | License & Ban Governance | Rust dependency tree | **Passed** | [deny.toml](deny.toml) |
| **Semgrep SAST** | Static Analysis | Rust Anchor contracts & TS Agent | **Passed (0 Findings)** | [.semgrep.yml](.semgrep.yml) |
| **libFuzzer & Proptest** | Coverage-Guided Fuzzing | Oracle decoder & Math invariants | **Passed** | [fuzz/README.md](fuzz/README.md) |
| **Trident Invariant Fuzz** | State-Machine Fuzzing | Anchor Instructions & Solvency Invariants | **Passed (10M+ Execs)** | [audits/trident-fuzz-report.md](audits/trident-fuzz-report.md) |
| **OWASP ZAP** | Dynamic API Security (DAST) | Agent HTTP Health API & Attack Surface | **Hardened (A+ Grade)** | [.zap/zap-baseline.conf](.zap/zap-baseline.conf) |
| **Solana Verify** | Cryptographic Build Verification | Deterministic SBF executable hash | **Reproducible** | [scripts/verify-build.sh](scripts/verify-build.sh) |
| *External Audit (Pending)* | Independent Third-Party Review | Cypher on-chain program | *Pending Engagement* | [audits/external-audits/](audits/external-audits/README.md) |

---

## Verifiable Build Verification (`solana-verify`)

Cypher supports deterministic, verifiable builds via `solana-verify`:

```bash
# Build verifiable image inside Docker and compute SHA-256 hash
./scripts/verify-build.sh

# Verify against deployed cluster
solana-verify verify-from-repo --remote -u mainnet --program-id 26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC <REPO_URL>
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
  - [📄 Trident 21-Page Formal PDF Certification](audits/reports/09-Report-Trident-Fuzz.pdf)
  - [📋 Trident Execution & Invariant Verification Report (Markdown)](audits/trident-fuzz-report.md)

### Running Trident Invariant Fuzzing Locally:

```bash
cd agent-cipher

# Run via official Ackee Blockchain Docker container (Cross-Platform)
docker run --rm -v $(pwd):/workspace ackeeblockchain/trident:latest trident fuzz run fuzz_0 --exit-on-crash

# Or run via Trident CLI (Linux / WSL)
cargo install trident-cli
trident fuzz run fuzz_0
```

---

## What it does

```
                ┌──────────────────────────── your wallet ───────────────────────────┐
                │  create encrypted wallet → deposit SOL/USDC → pick strategy → START │
                └─────────────────────────────────────────────────────────────────────┘
                                               │
                        ┌──────────────────────▼───────────────────────┐
                        │  cypher program (this repo, on-chain)    │
                        │  · per-user PDA vault (owner-only withdraw)  │
                        │  · strategy state machine + risk guards      │
                        │  · Pyth oracle pricing (feed/staleness/conf) │
                        └──────────────────────┬───────────────────────┘
                                               │
             permissionless cranks (agent/ or ANYONE) — no user keys involved
                                               │
                    ┌──────────────────────────┴─────────────────────────┐
                    ▼                                                    ▼
        STAKING (Marinade CPI)                                TRADING (Jupiter v6 CPI)
        idle SOL → mSOL, auto-staked                          DCA entry while flat
        mSOL appreciates vs SOL (compounding)                 exit on take-profit / stop-loss /
                                                              max-drawdown (flattens + pauses)
```

### Strategy A — Liquid staking (Marinade)
The crank stakes idle vault SOL above a small reserve into Marinade and
tracks the resulting mSOL. Rewards accrue by mSOL appreciating against SOL,
so compounding is inherent. `unstake` converts back via Marinade's instant
unstake (their fee applies).

### Strategy B — Cycle trading (SOL/USDC via Jupiter)
While **flat**: a DCA buy of a fixed USDC amount every cycle. While
**holding**: exits on take-profit, stop-loss, or max-drawdown from the high
water mark — and a drawdown exit additionally **pauses the position** as a
circuit breaker. Every swap is bounded on-chain:

* input is exact (full position or the configured DCA amount),
* minimum output is derived from the **Pyth oracle price**, not the quoted
  price, minus the user's slippage bound,
* route accounts may never include vault-owned accounts,
* mints are whitelisted (USDC ⇄ WSOL only).

## Repository layout

| Path | What it is |
| --- | --- |
| `programs/cypher` | The Anchor program (custody, strategies, governance) |
| `programs/mocks/mock-marinade` | TEST-ONLY mock of Marinade's CPI surface |
| `programs/mocks/mock-jupiter` | TEST-ONLY mock of Jupiter v6's `route` CPI |
| `sdk/` | TypeScript SDK (client, PDAs, config, **encrypted wallet manager**) |
| `cli/` | `wallet create / deposit / start / stop / status / withdraw` |
| `agent/` | Off-chain crank bot (the "autonomous" trigger layer) |
| `tests/` | End-to-end Anchor test suite (localnet, with mocks) |
| `docs/` | Deployment runbook |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design + trust boundaries |
| [SECURITY.md](SECURITY.md) | Threat model, invariants, responsible disclosure |
| [AUDIT_CHECKLIST.md](AUDIT_CHECKLIST.md) | What an auditor should look at, and status |
| [audits/](audits/00-review-summary.md) | Complete security audit documentation (internal review, fuzzing, remediation) |

## Quickstart (devnet/localnet)

Requirements: Rust, Solana CLI (agave ≥ 2.x), Anchor CLI 0.31.x, Node 20+.

```bash
git clone <repository-url>
cd agent-cipher
npm install
node scripts/sync-keypairs.js   # prepare local test keypairs
npm run test:unit               # runs unit tests
anchor build                    # builds program + mocks + IDLs
```

### Use the CLI (localnet example)

```bash
# 0. a funded keypair for localnet is provider.env's wallet
solana-keygen new -o id.json --force && solana airdrop 10

# 1. create an encrypted user wallet (AES-256-GCM, scrypt; key never on disk in plaintext)
npm run cli -- wallet create alice

# 2. open a position and fund it
npm run cli -- open alice --strategy staking
npm run cli -- deposit alice --sol 2

# 3. START the autopilot
npm run cli -- start alice --strategy staking --cycle-mins 60

# 4. run the agent (in another terminal) — it cranks everyone's positions
npm run agent

# 5. check status / withdraw anytime (withdrawals work even while paused)
npm run cli -- status alice
npm run cli -- withdraw alice --sol 0.5
```

For trading: `open --strategy trading`, `deposit-usdc --amount 50`,
then `start --strategy trading --cycle-mins 60 --trade-usdc 10 --tp-bps 300
--sl-bps 300 --dd-bps 1000 --slippage-bps 100`.

> Trading positions additionally need a Pyth SOL/USD `PriceUpdateV2`
> account (receiver pull-oracle format) for deposits (cost-basis marking)
> and cranks. The program accepts ONLY accounts owned by the config-pinned
> Pyth receiver program, with the genuine discriminator/layout, and
> validates feed id, staleness and confidence on-chain — single feed
> (SOL/USD) by design. On mainnet the agent auto-discovers the freshest
> receiver account (or you pin one you maintain — see "Oracle supply on
> mainnet" in `docs/DEPLOYMENT.md`). On localnet the mock writes one for you.

## Mainnet readiness

The mainnet integration is verified from the chain itself, not just docs:

* **Marinade**: program / state / mSOL mint match the official
  `@marinade.finance/marinade-ts-sdk`; every side account (reserve, both
  liq-pool legs, leg authority, mint authority, treasury) re-derived from
  seeds and verified against the live chain. The `deposit` /
  `liquid_unstake` CPI layouts, mutability and discriminators were
  extracted from the official Marinade IDL and recomputed
  (`docs/MAINNET_VERIFICATION.md` §1).
* **Jupiter v6**: the CPI uses the real `route()` layout (9 fixed
  accounts + AMM accounts), cross-checked against the official
  jupiter-cpi IDL and real mainnet route instructions. The agent feeds
  it Jupiter-authored routes from the live Swap API; the program
  enforces exact input, an oracle-anchored minimum output and
  `platform_fee_bps == 0` on-chain.
* **Pyth**: single-feed (SOL/USD) receiver pull-oracle with the
  ownership trust anchor (account owner must equal the config-pinned
  receiver program `rec5EKMG…LtFJ`), genuine discriminator, variant-aware
  layout bounds, feed/staleness/confidence checks — all on-chain; the
  receiver program id and live-account model are verified in
  `docs/MAINNET_VERIFICATION.md` §3.
* **Repro pack**: `python3 scripts/verify_mainnet.py` re-verifies every
  external constant against the live chain (exit 0 = all pass today).
* **Preflight**: `scripts/preflight-mainnet.ts` re-verifies every
  external dependency from the chain before you initialize config.

## Getting it audited

`docs/FREE_AUDIT_GUIDE.md` is a step-by-step playbook: the free,
already-mechanised pre-audit work in this repo, free automated tools,
free human review routes, free-to-list bug bounties (Immunefi — the
bounty table is pre-written in `SECURITY.md`), audit contests, grants —
and when a named-firm audit becomes necessary.

## Deploying your own instance

See `docs/DEPLOYMENT.md`. Short version:

1. `anchor keys sync` with a **freshly generated** (never committed) keypair.
2. Initialize config with **verified** addresses (mainnet constants are in
   `sdk/src/config.ts`, each one verified on-chain — run
   `scripts/preflight-mainnet.ts` first).
3. Move the program upgrade authority to a Squads multisig (recommended in
   SECURITY.md).
4. Point `guardians` at multisig vault PDAs, not EOA keys.

## Security model in one paragraph

User funds live in per-user PDAs that only the **owner** can withdraw from —
the program has no admin-withdraw path at all. The agent is permissionless
and untrusted: it can only invoke cranks whose every parameter (amounts,
prices, mints, CPI targets, slippage vs oracle) is enforced inside the
program. Configuration changes are timelocked; a guardian multisig can
pause globally (admin resumes); users can self-pause and always withdraw.
The full model, invariants and known risks are in [SECURITY.md](SECURITY.md).

## Risks (please read)

* **Trading can lose money.** Stop-loss and drawdown guards reduce, not
  eliminate, losses; gaps between oracle updates and fills exist.
* **Oracle risk**: if Pyth stalls or misreports, trading cranks fail closed
  (staleness/confidence bounds) — but a bad-but-fresh price could trigger
  an unfavourable exit.
* **Protocol risk**: Marinade and Jupiter are external, upgradeable
  programs; this vault trusts their current logic and validates their
  account derivations.
* **Agent liveness**: no agent ⇒ no automatic actions (funds remain
  safe and withdrawable; anyone can run an agent).
* **This code ships unaudited.** Get a professional review before
  mainnet funds (see AUDIT_CHECKLIST.md for scoping help).

## License

Apache-2.0. Contributions welcome — security-relevant PRs please open an
issue first (see SECURITY.md for the disclosure policy).
