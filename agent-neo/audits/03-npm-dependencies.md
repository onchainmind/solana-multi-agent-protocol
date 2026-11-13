# Audit Report: NPM Dependencies & Advisory Review

## 1. Overview
The TypeScript workspace (`agent`, `sdk`, `cli`, `tests`, `scripts`) was audited using `npm audit` against the GitHub Advisory Database.

---

## 2. Advisory Findings Summary

### Finding ID: CYPHER-SEC-011
### Title: Transitive NPM Package Vulnerabilities in Lockfile
- **Severity**: Medium
- **Affected File**: `package-lock.json`
- **Audit Tool Output**: 14 vulnerabilities (8 moderate, 6 high)

| Package | Severity | Advisory | Transitive Dependency Path | Resolution / Assessment |
| :--- | :--- | :--- | :--- | :--- |
| `bigint-buffer` | High | GHSA-3gc7-fjrx-p6mg (Buffer Overflow in `toBigIntLE`) | `@solana/spl-token` -> `@solana/buffer-layout-utils` -> `bigint-buffer` | Transitive C++ addon; not exposed to untrusted user network inputs in agent/client. |
| `toml` | High | GHSA-82x6-q7mm-w9cf (Prototype Pollution / Recursion) | `@coral-xyz/anchor` -> `toml` | Used strictly for parsing static IDL / Anchor.toml files at startup, not user input. |
| `stream-json` | Moderate | GHSA-528h-pc64-c93x (DoS via nested inputs) | `@solana/web3.js` -> `jayson` -> `stream-json` | Transitive RPC parser inside JSON-RPC client. |
| `uuid` | Moderate | GHSA-w5hq-g745-h8pq (Missing buffer bounds check) | `@solana/web3.js` -> `jayson` -> `uuid` | Used for JSON-RPC ID generation internally. |
| `serialize-javascript` | High | GHSA-5c6j-r48x-rmvq (RCE / XSS via regex) | `mocha` (devDependency only) | Test-runner dependency only; does not run in production. |

---

## 3. Analysis of Upgrade Breaking Changes
`npm audit fix --force` recommends automatically installing `@solana/web3.js@3.2.1` and `@solana/spl-token@0.1.8`.
> [!WARNING]
> **Breaking Change Incompatibility**:
> Upgrading `@solana/web3.js` from v1 (`^1.95.8`) to v2 or v3 breaks `@coral-xyz/anchor` (0.31.1), which strictly requires the v1 `Connection`, `PublicKey`, and `Transaction` interfaces.
> Downgrading or forcibly upgrading major versions destabilizes Anchor client deserialization.

### Mitigation:
- Do NOT run `npm audit fix --force`.
- Transitive packages (`bigint-buffer`, `toml`, `stream-json`) do not process untrusted public web inputs; they operate within local CLI/agent processes interacting with authenticated RPC endpoints.
- Monitor upstream `@coral-xyz/anchor` releases for future migration to `@solana/web3.js` v2/v3 when official support lands.
