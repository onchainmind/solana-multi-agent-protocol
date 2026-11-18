# Audit Report: Secrets & Private Key Exposure

## 1. Overview
A security scan was conducted across the entire repository to identify committed private keys, Solana keypairs, authentication credentials, RPC secrets, and sensitive tokens.

---

## 2. Key Findings

### Finding ID: CYPHER-SEC-001
### Title: Committed Private Key for Declared Program ID
- **Severity**: Critical
- **Affected File**: `tests/fixtures/cypher-keypair.json`
- **Original Issue**:
  The repository contained a committed JSON keypair whose derived public key (`26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC`) matched the program ID declared in `programs/cypher/src/lib.rs`, `Anchor.toml`, and `sdk/src/config.ts`.
- **Root Cause**:
  The developer committed `cypher-keypair.json` under `tests/fixtures/` with the intent of keeping local test validator builds reproducible, operating under the assumption that "a program keypair cannot move user funds and cannot upgrade a deployment it did not create."
- **Security Impact**:
  On-chain RPC inspection (`solana account 26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC`) across `mainnet-beta`, `devnet`, and `testnet` confirmed the account does not yet exist on-chain (`AccountNotFound`).
  Because the program address has not yet been deployed on mainnet or devnet, **anyone possessing the private key can deploy the program first**, becoming the initial upgrade authority. An attacker could deploy malicious bytecode, intercept prospective user deposits, or block the legitimate team from deploying to that address.
- **Proof of Concept**:
  Deriving the public key via `solana-keygen pubkey tests/fixtures/cypher-keypair.json` outputs:
  `26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC`.
  Checking mainnet deployment state via `solana account 26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC -u mainnet-beta` returns `AccountNotFound`.
- **Implemented Solution**:
  1. Removed `tests/fixtures/cypher-keypair.json` permanently from the repository source.
  2. Updated `.gitignore` to strictly forbid committing `*.keypair.json`, `*keypair*.json`, `*.secret`, `*.key`, `*.pem`, `id.json`, and `.keys/`.
  3. Updated `tests/fixtures/README.md` to remove misleading assertions and mandate generating fresh keys for deployment.
  4. Updated `scripts/sync-keypairs.js` and `tests/cypher.ts` to generate disposable keypairs in `target/deploy/cypher-keypair.json` for local test and CI runs.
  5. Implemented an automated secret scanning tool (`scripts/scan-secrets.js`) executed in CI and pre-commit checks.
- **Verification**:
  Executed `node scripts/scan-secrets.js`:
  Result: `Secret scan passed: zero unallowlisted private keys or secrets detected.`
- **Status**: Fixed
- **Remaining Risk**:
  Deleting a file in a working directory does not purge it from historical Git commits if the repository was previously tracked. Maintainers must ensure this keypair is scrubbed using `git-filter-repo` or BFG Repo-Cleaner before public push, and must generate a completely fresh program keypair (`node scripts/new-program-keypair.js`) prior to any devnet or mainnet deployment.

---

## 3. Automated Secret Scanning Safeguards
An automated scanner `scripts/scan-secrets.js` was introduced to scan for:
- 64-byte Solana keypair JSON arrays.
- Base58 private keys and private key PEM blocks.
- Hardcoded secrets in environment variables (`AGENT_SECRET_KEY_B58`, `SECRET_KEY`, `PRIVATE_KEY`).
The scanner is integrated into the CI pipeline in `.github/workflows/ci.yml`.
