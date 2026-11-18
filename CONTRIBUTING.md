# Contributing to Autonomous Web3 Agents

We welcome open-source contributions to the Cypher agent and the multi-agent ecosystem.
To maintain high security and code quality for on-chain smart contracts, please adhere to the following guidelines.

---

## 1. Security First
- **Zero Secrets**: NEVER commit private keys, Solana keypairs, `.env` files with live values, API keys, or RPC authentication tokens.
- **Run Secret Scan**: Every PR must pass `npm run scan:secrets` before submission.
- **Never Weaken Validation**: Do not remove, relax, or bypass on-chain account constraints, signer checks, PDA validations, or oracle bounds.
- **Vulnerability Disclosure**: If you discover a security vulnerability, do NOT open a public GitHub issue. Follow the private reporting process in [SECURITY.md](SECURITY.md).

---

## 2. Development & Pull Request Workflow

1. **Fork & Branch**:
   Create a focused feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Navigate to the Active Agent**:
   Currently, all development takes place inside `agent-cipher/`:
   ```bash
   cd agent-cipher
   npm install
   ```

3. **Verify Code Quality**:
   Before committing, verify all automated checks pass locally:
   ```bash
   # 1. Scan for secrets
   npm run scan:secrets

   # 2. Run unit tests
   npm run test:unit

   # 3. Typecheck TypeScript
   npm run typecheck

   # 4. Check Rust contract formatting & lints (if modifying programs/)
   cargo clippy --workspace --all-targets -- -D warnings
   ```

4. **Commit Guidelines**:
   Write clear, concise commit messages following standard conventions:
   - `fix(agent): enforce bounds on compute unit limits`
   - `feat(sdk): add helper for position status derivation`
   - `test(oracle): add fuzz test for negative exponent bounds`

5. **Submitting a Pull Request**:
   - Provide a clear description of the problem solved and changes introduced.
   - Reference any related issues.
   - Confirm that all unit tests, static analysis checks, and secret scans pass.

---

## 3. Architecture Rules
- All Cypher agent source code, tests, scripts, and documentation must reside inside `agent-cipher/`.
- Reserved agent folders (`agent-trinity/`, `agent-morpheus/`, `agent-oracle/`, `agent-neo/`, `agent-quantum/`) are reserved for future agent releases — do not add placeholder code or move Cypher files into those folders.
- Preserved APIs: Backward-compatible interfaces in `sdk/` and `programs/cypher/` must be maintained unless coordinated through formal governance changes.

---

## 4. Code of Conduct
We are committed to providing a welcoming, inclusive, and professional environment for all contributors. Respectful collaboration is expected at all times.

