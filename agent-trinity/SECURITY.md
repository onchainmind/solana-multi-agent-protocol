# Security Policy & Threat Model

## 1. Responsible Disclosure

Found a vulnerability? **Do not open a public issue.**

Please report security issues using GitHub's **Private Vulnerability Reporting** (Repository Settings → Security → Report a vulnerability).
This ensures your report is received privately and securely by the maintainers.

We commit to:
- Acknowledging your report within 48 hours.
- Providing an assessment and target resolution timeline.
- Coordinating public disclosure following remediation.
- Crediting security researchers who adhere to responsible disclosure.

---

## 2. Independent Audit Status

> [!IMPORTANT]
> **Audit Status: Pending Independent Third-Party Review**
> This codebase has undergone internal manual code review, fuzz testing, and static analysis.
> However, **it has not yet received a formal external audit from an independent third-party security firm.**
> Do not risk production capital without performing independent due diligence.

---

## 3. Threat Model

### Assets Protected
- User deposits (SOL / WSOL / USDC / mSOL) held in per-user PDA vaults.
- Operational liveness and strategy execution.
- Administrative configuration and governance timelock integrity.

### Actors & Capabilities Matrix

| Actor | Permitted Actions | Prohibited Actions |
| :--- | :--- | :--- |
| **User (Owner)** | Deposit, withdraw (any time, even when paused), start/stop strategy, configure params within protocol limits. | Cannot access or withdraw another user's funds; cannot bypass protocol bounds. |
| **Autonomous Agent** | Submit permissionless cranks for active, eligible positions. | Cannot choose prices, amounts, or mints; cannot sign as user; cannot transfer funds to arbitrary accounts. |
| **Admin** | Propose timelocked configuration changes, execute approved changes after delay, initiate two-step admin transfer, resume from pause. | Cannot execute instantaneous config changes; cannot bypass timelock; cannot withdraw user deposits (no withdrawal instruction exists). |
| **Guardian** | Break-glass global pause (`guardian_pause`). | Cannot resume operations; cannot change config; cannot withdraw funds. |
| **Adversary / External** | Run arbitrary agents, pass hostile swap routes, stale oracle accounts, or front-run in public mempool. | Blocked by on-chain PDA verification, Pyth receiver ownership checks, exact-input balance tracking, oracle-anchored output floors, and vault-account route exclusions. |

---

## 4. Key Security Invariants

1. **Non-Custodial Invariant**: Only user-signed instructions (`withdraw_sol`, `withdraw_usdc`, `withdraw_wsol`) can transfer funds out of a user's vault to an arbitrary destination.
2. **Strategy Gate Invariant**: Cranks cannot execute if the protocol is globally paused, the position is self-paused, the strategy is inactive, or cooldowns have not elapsed.
3. **Swap Safety Invariant**: Every trade enforces exact input, whitelisted tokens, oracle-anchored minimum output, `platform_fee_bps == 0`, and complete exclusion of vault accounts from route accounts and pass-through slots.
4. **Marinade CPI Invariant**: Every Marinade CPI re-derives all required PDAs on-chain from the configured state before executing.
5. **Oracle Invariant**: Pyth oracle accounts must be owned by the config-pinned Pyth Solana Receiver program, carry the verified discriminator, match the configured feed ID, satisfy freshness bounds (`[now - staleness, now + 60s]`), and meet confidence bounds.
6. **Governance Invariant**: Config changes require a mandatory timelock delay; the timelock delay parameter is monotonically increasing.
7. **Clean Exit Invariant**: Position accounts can only be closed when all token balances (`mSOL`, `USDC`, `WSOL`) are exactly zero.

---

## 5. Scope for Independent Security Auditors

Auditors are encouraged to focus on:
- Smart contract logic in `programs/cypher/src/`.
- CPI account validation and invocation in `programs/cypher/src/cpi/`.
- Fixed-point arithmetic and slippage mathematics in `programs/cypher/src/math.rs`.
- Pyth `PriceUpdateV2` parsing and trust anchors in `programs/cypher/src/oracle.rs`.
- Agent transaction construction and RPC simulation in `agent/src/`.
