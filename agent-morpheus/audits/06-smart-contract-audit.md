# Audit Report: Smart Contract Security Audit

## 1. Scope & Architecture
Target smart contract: `programs/cypher/src/`
- `lib.rs`: Program entrypoint and instruction declarations.
- `state.rs`: Account structs (`GlobalConfig`, `UserPosition`, `TimelockEntry`).
- `instructions/admin.rs`: Governance, two-step admin transfer, timelocked upgrades, pause circuit breaker.
- `instructions/position.rs`: Non-custodial vault deposits, withdrawals, strategy start/stop/pause, position closure.
- `instructions/crank.rs`: Autonomous permissionless execution (`crank_stake`, `crank_trade`).
- `cpi/jupiter.rs` & `cpi/marinade.rs`: CPI execution wrappers.
- `oracle.rs`: Pyth `PriceUpdateV2` parsing and price validation.
- `math.rs`: Fixed-point mathematics and slippage calculations.

---

## 2. In-Depth Account Validation Review

### UncheckedAccount Verification Proofs:

| Context Struct | Field | Verification Proof & Defense Mechanism |
| :--- | :--- | :--- |
| `CrankStake` | `owner` | Constrained via `constraint = owner.key() == position.owner @ CypherError::Unauthorized`. Cannot be forged. |
| `CrankStake` | `marinade_program` | Address-pinned: `address = config.marinade_program @ CypherError::InvalidMarinadeAccounts`. |
| `CrankStake` | `marinade_state` | Address-pinned: `address = config.marinade_state @ CypherError::InvalidMarinadeAccounts`. |
| `CrankStake` | `msol_mint` | Address-pinned: `address = config.msol_mint @ CypherError::InvalidMint`. |
| `CrankStake` | `liq_pool_sol_leg` | On-chain PDA re-derivation in `verify_marinade_pdas` via `find_program_address(&[state, b"liq_sol"])`. |
| `CrankStake` | `liq_pool_msol_leg` | Re-derived via `Pubkey::create_with_seed(&state, "liq_st_sol", &spl_token::ID)`. |
| `CrankStake` | `liq_pool_msol_leg_authority` | On-chain PDA re-derivation in `verify_marinade_pdas` via `find_program_address(&[state, b"liq_st_sol_authority"])`. |
| `CrankStake` | `reserve_pda` | On-chain PDA re-derivation via `find_program_address(&[state, b"reserve"])`. |
| `CrankStake` | `msol_mint_authority` | On-chain PDA re-derivation via `find_program_address(&[state, b"st_mint"])`. |
| `CrankTrade` | `owner` | Constrained via `constraint = owner.key() == position.owner @ CypherError::Unauthorized`. |
| `CrankTrade` | `pyth_price` | Account ownership validated against `config.pyth_receiver_program`; Anchor discriminator `PRICE_UPDATE_V2_DISCRIMINATOR` verified; feed ID and publish timestamps verified. |
| `CrankTrade` | `swap_program` | Address-pinned to `config.swap_program`. |
| `CrankTrade` | `jup_src_ta` | Validated against the user position's exact vault ATA for the swap direction. |
| `CrankTrade` | `jup_dst_ta` | Validated against the user position's exact vault ATA for the swap direction. |
| `CrankTrade` | `jup_dst_mint` | Validated against config whitelist mints (`wsol_mint` on buy, `usdc_mint` on sell). |
| `CrankTrade` | `jup_event_authority` | Re-derived on-chain via `find_program_address(&[b"__event_authority"], &config.swap_program)`. |
| `CrankTrade` | `jup_program_acct` | Pinned to `config.swap_program`. |
| `CrankTrade` | `jup_destination_token_account` | Validated: must NOT match any vault-controlled account (`vault_usdc`, `vault_wsol`, `vault_msol`, `native_vault`, or `position`). |
| `CrankTrade` | `jup_platform_fee_account` | Validated: must NOT match any vault account, and route payload byte `platform_fee_bps` is enforced `== 0`. |

---

## 3. Discovered Vulnerabilities & Remediations

### Finding ID: CYPHER-SEC-007
### Title: Incomplete Route Account Exclusion in CrankTrade
- **Severity**: High
- **Affected File**: `programs/cypher/src/instructions/crank.rs` (lines 527–534)
- **Original Issue**:
  The `validate_swap_accounts` function excluded only `vault_usdc`, `vault_wsol`, and `position_key` from appearing in `remaining_accounts` (Jupiter route accounts). It failed to exclude `vault_msol` (the user's staked mSOL ATA) and `native_vault` (the companion native SOL vault PDA).
- **Root Cause**:
  The developer assumed that because `crank_trade` trades between WSOL and USDC, only `vault_usdc` and `vault_wsol` needed to be protected from route injection.
- **Security Impact**:
  In `jupiter_route_cpi`, the `position` account signs via PDA seeds `[b"position", owner, bump]`. The `position` PDA is also the token authority of `vault_msol`. If an attacker injected `vault_msol` into `remaining_accounts`, a malicious or compromised route instruction could transfer mSOL tokens authorized by the position's PDA signature.
- **Implemented Solution**:
  Updated `validate_swap_accounts` in `crank.rs`:
  1. Derived `vault_msol` via `vault_ata_pub(position_key, &config.msol_mint)`.
  2. Derived `native_vault` via `Pubkey::find_program_address(&[VAULT_SEED, accounts.owner.key().as_ref()], &crate::ID)`.
  3. Created a comprehensive `forbidden_keys` list:
     `let forbidden_keys = [vault_usdc, vault_wsol, vault_msol, native_vault, *position_key];`
  4. Enforced that none of the `forbidden_keys` can appear in `remaining_accounts`, `jup_destination_token_account`, or `jup_platform_fee_account`.
- **Status**: Fixed

---

### Finding ID: CYPHER-SEC-008
### Title: Inverted Error Code in ClosePosition Validation
- **Severity**: Medium
- **Affected File**: `programs/cypher/src/instructions/position.rs` (line 436), `programs/cypher/src/errors.rs`
- **Original Issue**:
  `close_position` evaluated `require!(!p.active, CypherError::StrategyNotActive);`.
  When a user called `close_position` with an active strategy, the transaction reverted with `StrategyNotActive` ("Strategy is not active; call start_strategy first"), creating user confusion and misleading error logs.
- **Implemented Solution**:
  Added a distinct error variant `StrategyStillActive` ("Strategy is still active; call stop_strategy before closing position") to `errors.rs` and updated `close_position`.
- **Status**: Fixed

---

### Finding ID: CYPHER-SEC-013
### Title: External Protocol Upgradeability Risk
- **Severity**: Medium
- **Affected File**: `programs/cypher/src/cpi/marinade.rs`, `programs/cypher/src/oracle.rs`
- **Original Issue**:
  Marinade Finance and the Pyth Solana Receiver program remain upgradeable by their respective governance entities.
- **Security Impact**:
  If Marinade or Pyth modifies their instruction account layout or account data structures, CPI calls or oracle parsing could fail, temporarily halting cranks.
- **Mitigation & Accepted Risk**:
  1. Cypher does not hardcode program IDs; they are pinned in `GlobalConfig` and updateable via the governance timelock (`execute_config_change`).
  2. All Marinade accounts and Pyth message structures are re-validated field-by-field on-chain prior to execution.
  3. Preflight scripts (`scripts/preflight-mainnet.ts` and `scripts/verify_mainnet.py`) inspect live on-chain bytecode and account layouts before deployment.
- **Status**: Accepted Risk
