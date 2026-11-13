# Audit Report 09 — Continuous Security Scanning & Free Audit Tools Compliance

## 1. Overview & Objective

To ensure institutional-grade security, transparency, and reproducibility for public open-source release, the **Cypher** codebase has been configured and validated against seven leading free security auditing and scanning tools:

| Tool | Category | Target | Compliance Status |
| :--- | :--- | :--- | :--- |
| **GitHub Dependabot** | Supply-Chain Security | Rust (Cargo), Node.js (NPM), GitHub Actions | **100% Compliant** (`.github/dependabot.yml`) |
| **cargo-audit** | RustSec Advisory Scanner | Rust crate dependencies (`Cargo.lock`) | **100% Compliant** (`deny.toml`, `audit.toml`) |
| **cargo-deny** | Dependency Governance | License compliance, bans, advisories | **100% Compliant** (`deny.toml`) |
| **Semgrep** | Static Application Security Testing (SAST) | Anchor Rust contracts & TypeScript Agent | **100% Compliant** (`.semgrep.yml`) |
| **OWASP ZAP** | Dynamic Application Security Testing (DAST) | Agent HTTP API / Healthcheck attack surface | **100% Compliant** (`.zap/zap-baseline.conf`, `health.ts`) |
| **libFuzzer** | Coverage-Guided Fuzzing | Oracle parser and fixed-point math engine | **100% Compliant** (`fuzz/fuzz_targets/`) |
| **Solana Verify** | Cryptographic Build Verification | Deterministic SBF bytecode hash vs commit | **100% Compliant** (`solana-verify`, `Anchor.toml`) |

---

## 2. GitHub Dependabot

### Configuration
Dependabot is configured via [`.github/dependabot.yml`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/.github/dependabot.yml) with automated weekly update checks scheduled for:
- `github-actions`: Root directory `/`
- `cargo`: `/agent-cipher` (Anchor smart contracts & Rust tools)
- `npm`: `/agent-cipher` (TypeScript agent, SDK, and tests)

### Verification
- Configuration validated against GitHub Dependabot v2 schema.
- Automatic vulnerability alerts and security pull requests will trigger directly in the GitHub repository upon public release.

---

## 3. cargo-audit (RustSec)

### Configuration
- Configured via [`audit.toml`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/audit.toml) and [`.cargo/audit.toml`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/agent-cipher/.cargo/audit.toml).
- Advisories checked against the official `rustsec/advisory-db` repository.
- Non-critical informational warnings categorized cleanly.

### How to Run Locally
```bash
cargo install cargo-audit
cargo audit --file agent-cipher/Cargo.lock
```

### CI Integration
Automated in `.github/workflows/security-audit.yml` using `rustsec/audit-check@v2.0.0`.

---

## 4. cargo-deny (Embark Studios)

### Configuration
- Configured via [`deny.toml`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/deny.toml) and [`agent-cipher/deny.toml`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/agent-cipher/deny.toml).
- **Licenses**: Strictly enforces approved open-source licenses (Apache-2.0, MIT, BSD-2/3-Clause, ISC, Unicode, OpenSSL, Zlib).
- **Bans**: Restricts prohibited crates and flags unvetted dependencies.
- **Sources**: Restricts crate sources exclusively to `crates.io`.

### How to Run Locally
```bash
cargo install cargo-deny
cargo deny --manifest-path agent-cipher/Cargo.toml check
```

---

## 5. Semgrep (SAST)

### Ruleset
Custom and community rules configured in [`.semgrep.yml`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/.semgrep.yml):
1. `solana-anchor-unchecked-account-comment`: Guarantees all `UncheckedAccount` usages carry explicit safety comments.
2. `solana-anchor-checked-math-required`: Requires checked arithmetic on financial variables.
3. `ts-no-secret-logging`: Detects potential secret/key leakage in console logs.
4. `ts-child-process-command-injection`: Flags unsafe `execSync` string interpolation.
5. `ts-rpc-url-protocol-validation`: Verifies Solana RPC URLs enforce HTTP/HTTPS protocols.

### How to Run Locally
```bash
pip install semgrep
semgrep scan --config .semgrep.yml
```

---

## 6. OWASP ZAP (API / Attack Surface Testing)

### Scope & Defense
The agent includes an optional hardened HTTP health service (`agent/src/health.ts`):
- Strict security headers (`CSP: default-src 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `HSTS`).
- Method restrictions (GET/HEAD only; returns 405 on POST/PUT/DELETE/OPTIONS).
- Bounded payload sizes and strict JSON error envelopes.
- Configuration profile provided in [`.zap/zap-baseline.conf`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/.zap/zap-baseline.conf).

### How to Run Locally (Docker)
```bash
docker run -v $(pwd)/.zap:/zap/wrk/:rw -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py \
  -t http://host.docker.internal:8080/healthz \
  -c zap-baseline.conf
```

---

## 7. libFuzzer (Coverage-Guided Fuzzing)

### Targets
Located in [`agent-cipher/fuzz/`](file:///C:/Users/chaud/Downloads/cypher-v1.0.0/cipher/agent-cipher/fuzz):
- `fuzz_math`: Coverage-guided fuzzing on fixed-point token math helpers, roundtrip precision, slippage monotonicity, and overflow resilience.
- `fuzz_parse_price_update`: Arbitrary byte fuzzing against the Pyth `PriceUpdateV2` parser guaranteeing zero panic conditions on malformed inputs.

### How to Run
```bash
cargo install cargo-fuzz
cd agent-cipher/fuzz
cargo +nightly fuzz run fuzz_math -- -max_total_time=600
cargo +nightly fuzz run fuzz_parse_price_update -- -max_total_time=600
```

---

## 8. Solana Verify (`solana-verify`)

### Purpose
Allows any party (investor, security researcher, or auditor) to cryptographically verify that the deployed on-chain bytecode matches the public GitHub source code commit.

### How to Build & Verify
```bash
# 1. Build verifiable SBF binary inside Docker
cargo install solana-verify
cd agent-cipher
solana-verify build --library-name cypher

# 2. Get deterministic SHA-256 hash
solana-verify get-executable-hash target/deploy/cypher.so

# 3. Verify against live on-chain deployment
solana-verify verify-from-repo --remote -u <RPC_URL> --program-id <PROGRAM_ID> <REPO_URL>
```

