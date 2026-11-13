# tests/fixtures — Keypair Policy & Test Fixtures

## 1. Mock Program Keypairs (Localnet Test Fixtures)
- `mock_marinade-keypair.json`
- `mock_jupiter-keypair.json`

These keypairs are **strictly for localnet development and automated unit testing**.
They correspond to test-only mock programs (`mock-marinade` and `mock-jupiter`).
They hold zero value, are never deployed to devnet or mainnet, and are used solely to allow local Anchor tests and CI to execute deterministic CPI simulations without accessing mainnet accounts.

## 2. Program Keypair Policy (Security Rule)
- The main program deploy keypair (`cypher-keypair.json`) is **NEVER committed to public version control**.
- **Security Rationale**: Publishing the private key of an undeployed or upgradeable program address allows an attacker to front-run the deployment on any network (mainnet, devnet, testnet), claim the declared program ID, and take control of the initial upgrade authority. Even if deployed, exposing private keys violates fundamental security hygiene.
- Real deployments must always generate an independent, offline keypair (`solana-keygen new --no-bip39-passphrase -o .keys/cypher.json`) and run `anchor keys sync` to bind the new program ID.
- Local automated tests generate a disposable local keypair on demand in `target/deploy/cypher-keypair.json` via `node scripts/sync-keypairs.js`.
