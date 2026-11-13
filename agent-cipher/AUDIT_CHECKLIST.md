# Security & Audit Readiness Checklist

## Security & Verification Status Disclaimer
> [!IMPORTANT]
> **Independent Audit Status**: Pending Independent Security Review.
> This repository has undergone extensive **internal manual code review, automated static analysis, and security hardening** (dated November 2026).
> **No independent, third-party security certification or audit has yet been conducted.**
> Prior claims of "Zero Warnings and Zero Critical Issues" referred strictly to internal static analysis and compiler warnings under strict flags, NOT a third-party audit clearance.
> Users, developers, and integrators must exercise caution when evaluating this smart contract system.

---

## Status Legend
- ✅ **Verified Internally** — Validated by internal manual code review, automated testing, and static analysis.
- ⚠️ **Documented Residual / External Risk** — Operational or protocol property requiring user or integrator awareness.
- ⏳ **Pending External Review** — Awaiting formal third-party independent smart contract audit.

---

## 1. Code-Level Hygiene & Authorization
- ✅ **Anchor 0.31.1 Architecture**: Anchor framework constraints applied across instruction contexts.
- ✅ **Checked Arithmetic**: `checked_*` arithmetic used across math operations; `overflow-checks = true` enforced in Cargo profiles.
- ✅ **Distinct Error Codes**: Comprehensive error taxonomy in `errors.rs` ensuring deterministic error debugging.
- ✅ **Event Logging**: Anchor events emitted on all state transitions for off-chain indexing and monitoring.
- ✅ **Secret Hygiene**: Committed program keypairs removed; public clone and CI workflows rely on disposable test keypairs.
- ✅ **Account Ownership & Discriminator Validation**: Strict checks on all accounts, preventing arbitrary account substitution.
- ⏳ **Third-Party Formal Verification**: Awaiting formal verification and independent external audit.

---

## 2. Custody & User Fund Safety
- ✅ **Per-User PDA Vault**: Funds are custodied strictly in per-user PDA vaults (`["position", owner]` and companion `["vault", owner]`).
- ✅ **Owner-Only Withdrawals**: Only the authenticated owner signer can withdraw funds (`withdraw_sol`, `withdraw_usdc`, `withdraw_wsol`).
- ✅ **No Admin Withdrawal Gate**: No protocol or admin backdoors exist to drain user deposits.
- ✅ **Unrestricted Withdrawals During Pause**: Users retain the ability to withdraw funds even when the protocol is globally or individually paused.
- ✅ **Rent & Dust Reclamation**: Position close requires all token account balances to be exactly zero before returning rent lamports to owner.

---

## 3. Strategy Execution & CPI Safety
- ✅ **Deterministic Decision Logic**: Crank parameters (action, trade size, oracle pricing) are evaluated on-chain.
- ✅ **Exact Input Verification**: Vault balance deltas before and after swaps ensure exact token amounts are consumed.
- ✅ **Oracle-Anchored Output Floor**: Slippage is enforced against Pyth oracle prices, not arbitrary client quote values.
- ✅ **Route Account Exclusion**: All vault accounts (`vault_usdc`, `vault_wsol`, `vault_msol`, `native_vault`, and `position`) are strictly forbidden from appearing in Jupiter swap route accounts or pass-through fee/destination slots.
- ✅ **Marinade PDA Re-Derivation**: All Marinade liquid staking PDAs are re-derived on-chain from the state account prior to issuing CPI calls.
- ✅ **Automated Drawdown Circuit Breaker**: Exceeding max drawdown triggers automated position self-pause.
- ⚠️ **MEV & Slippage in Public Mempool**: Transactions submitted by permissionless agents are subject to public Solana mempool visibility; slippage bounds protect output floors, but front-running within tolerance remains an inherent blockchain risk.

---

## 4. Governance & Administrative Controls
- ✅ **Two-Step Admin Transfer**: Admin replacement requires a proposal followed by acceptance from the nominated address.
- ✅ **Break-Glass Guardian Pause**: Any designated guardian can immediately pause protocol operations.
- ✅ **Admin-Only Resume**: Resuming protocol operations requires explicit admin authority.
- ✅ **Timelock Governance**: Non-trivial configuration changes require a mandatory timelock delay.
- ✅ **Monotonic Timelock Delay**: Timelock delay parameter can only be increased, preventing sudden reduction of governance notice periods.

---

## 5. Oracle Security (Pyth SOL/USD Pull Oracle)
- ✅ **Pyth Receiver Ownership**: Oracle accounts are accepted only if owned by the Pyth Solana Receiver program (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`).
- ✅ **Discriminator & Layout Validation**: Custom byte parser validates `PriceUpdateV2` Anchor discriminator and Borsh payload bounds.
- ✅ **Feed ID Pinning**: Oracle messages must match the configured 32-byte Pyth SOL/USD feed ID.
- ✅ **Price Freshness**: Rejects prices older than `max_price_staleness_secs` or timestamped unreasonably far in the future.
- ✅ **Confidence Interval Bound**: Rejects price feeds with wide confidence intervals (`conf <= price * conf_bps / 10_000`).

---

## 6. Documented External Factors & Residual Risks
1. **External Contract Upgradeability**:
   - Marinade and Pyth receiver programs on Solana remain upgradeable by their respective governance entities.
   - Mitigation: Config pins program IDs via timelock; all CPI accounts are re-derived on-chain.
2. **Oracle Pull Availability**:
   - Trading cranks depend on regular publication of fresh `PriceUpdateV2` pull-oracle accounts.
   - If network congestion stalls oracle updates, trading cranks safely halt until fresh prices appear.
3. **Agent Liveness**:
   - Agent execution is permissionless; anyone can run an agent to submit due cranks.
   - If agents fail, funds remain secure in vaults and user withdrawals are unaffected.
