//! On-chain state for the Cypher program.
//!
//! Everything is stored in plain Anchor accounts. There are three account
//! types:
//!
//! * [`GlobalConfig`] – singleton holding protocol-wide settings (CPI
//!   targets, oracle parameters, risk bounds). All changes go through a
//!   timelock.
//! * [`UserPosition`] – one per user (PDA derived from the owner). It is
//!   ALSO the vault: it holds native SOL lamports and is the authority of
//!   the vault SPL token accounts (mSOL / USDC / WSOL).
//! * [`TimelockEntry`] – a queued configuration change that can only be
//!   executed after the timelock delay has elapsed.

use anchor_lang::prelude::*;

/// Seed for the singleton [`GlobalConfig`] PDA.
pub const CONFIG_SEED: &[u8] = b"config";
/// Seed prefix for every [`UserPosition`] PDA (`["position", owner]`).
pub const POSITION_SEED: &[u8] = b"position";
/// Seed prefix for [`TimelockEntry`] PDAs (`["timelock", config, nonce]`).
pub const TIMELOCK_SEED: &[u8] = b"timelock";
/// Seed prefix for the per-position native-SOL vault PDA
/// (`["vault", owner]`). This account is SYSTEM-owned (no data) so it can
/// send lamports via the System Program — the data-carrying
/// [`UserPosition`] PDA cannot.
pub const VAULT_SEED: &[u8] = b"vault";

/// Sentinel pubkey meaning "unset" (e.g. pending admin).
pub const NO_ADMIN: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// Strategy selected by the user when starting the autonomous agent.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum StrategyKind {
    /// No strategy selected yet (position just opened / stopped).
    #[default]
    None,
    /// Liquid staking via Marinade CPI (SOL -> mSOL), auto-staked by the
    /// permissionless crank. mSOL appreciates against SOL as staking
    /// rewards accrue (auto-compounding by construction).
    Staking,
    /// Cycle trading via Jupiter CPI: DCA entry into WSOL with USDC while
    /// flat, exit on take-profit / stop-loss / max-drawdown, all executed
    /// and bounded on-chain against a Pyth oracle price.
    Trading,
}

/// User-configurable strategy parameters. Bounds are enforced against
/// [`GlobalConfig`] limits at `start_strategy`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct StrategyParams {
    /// Staking: minimum seconds between stake operations.
    /// Trading: DCA cycle length in seconds (minimum 60).
    pub cycle_secs: i64,
    /// Trading only: USDC (6dp) deployed per DCA buy.
    pub trade_amount_usdc: u64,
    /// Trading only: exit when price >= avg_entry * (1 + tp/1e4). 0 = off.
    pub take_profit_bps: u16,
    /// Trading only: exit when price <= avg_entry * (1 - sl/1e4). 0 = off.
    pub stop_loss_bps: u16,
    /// Trading only: flatten + self-pause when price falls this far below
    /// the high water mark. 0 = off.
    pub max_drawdown_bps: u16,
    /// Max slippage (bps) tolerated on every swap. Enforced on-chain
    /// against the oracle price, not the quoted price.
    pub slippage_bps: u16,
}

impl StrategyParams {
    pub const SPACE: usize = 8 + 8 + 2 + 2 + 2 + 2; // 24
}

/// Singleton configuration. Only created once via `initialize`.
/// Mutable fields are ONLY changed through `execute_config_change`
/// (timelocked) or the guardian pause switch.
#[account]
pub struct GlobalConfig {
    /// Current admin (upgradeable config owner). Transfer is two-step.
    pub admin: Pubkey,
    /// Proposed new admin; must call `accept_admin` to take over.
    pub pending_admin: Pubkey,
    /// Break-glass guardians. ANY one of them can globally pause.
    /// Use a Squads multisig vault pubkey here for an on-chain multisig.
    pub guardians: [Pubkey; 3],
    /// Global circuit breaker set by admin or a guardian.
    pub paused: bool,

    // ---- Protocol (CPI) targets. Verified against config on every use. ----
    /// Marinade liquid-staking program id (mainnet: MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD).
    pub marinade_program: Pubkey,
    /// Marinade state account (mainnet: 8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC).
    pub marinade_state: Pubkey,
    /// mSOL mint (mainnet: mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So).
    pub msol_mint: Pubkey,
    /// Marinade treasury mSOL token account (read from marinade state by
    /// the deployer and pinned here; used by `liquid_unstake` CPI).
    pub msol_treasury: Pubkey,
    /// Swap router program id (mainnet: Jupiter v6 JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4,
    /// localnet: mock-jupiter).
    pub swap_program: Pubkey,
    /// USDC mint used as the stable side of the trading strategy.
    pub usdc_mint: Pubkey,
    /// Wrapped SOL mint (So11111111111111111111111111111111111111112).
    pub wsol_mint: Pubkey,

    // ---- Oracle ----
    /// Pyth Solana Receiver program that owns the accepted
    /// `PriceUpdateV2` oracle accounts (mainnet:
    /// rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ). Every oracle
    /// account MUST be owned by this program — the receiver only writes
    /// Wormhole-verified Pyth VAAs, so this check makes the oracle trust
    /// anchor explicit and closes the "any well-formed account" hole.
    pub pyth_receiver_program: Pubkey,
    /// Pyth SOL/USD feed id (mainnet/devnet:
    /// ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d).
    pub sol_usd_feed_id: [u8; 32],
    /// Maximum accepted age (seconds) of the oracle price.
    pub max_price_staleness_secs: i64,
    /// Maximum accepted confidence interval width, in bps of the price.
    pub max_price_conf_bps: u64,

    // ---- Risk bounds ----
    /// Hard cap on user-configured slippage (bps).
    pub max_slippage_bps: u16,
    /// Minimum `deposit_sol` size (lamports).
    pub min_deposit_lamports: u64,
    /// Maximum single `deposit_sol` size (lamports).
    pub max_deposit_lamports: u64,
    /// Hard cap on `StrategyParams::trade_amount_usdc`.
    pub max_trade_usdc: u64,
    /// Minimum stake operation size (lamports) for the staking crank.
    pub min_stake_lamports: u64,
    /// Native lamports that must remain in a position PDA (rent for the
    /// position data account plus a small buffer). Never staked/swapped.
    pub min_reserve_lamports: u64,

    // ---- Governance ----
    /// Minimum delay (seconds) between proposing and executing a config
    /// change. Can only be increased.
    pub timelock_delay_secs: i64,
    /// Monotonic counter used for timelock PDA derivation.
    pub timelock_nonce: u64,
    /// Nonce of the currently pending (not yet executed) timelock entry,
    /// or 0 when no change is pending.
    pub pending_change_nonce: u64,

    /// PDA bump of this account.
    pub bump: u8,
}

impl GlobalConfig {
    /// 8 (discriminator) + field sizes below.
    pub const SPACE: usize = 8
        + 32   // admin
        + 32   // pending_admin
        + 96   // guardians [3]
        + 1    // paused
        + 32 * 6 // marinade_program, marinade_state, msol_mint, msol_treasury, swap_program, usdc_mint
        + 32   // wsol_mint
        + 32   // pyth_receiver_program
        + 32   // sol_usd_feed_id
        + 8    // max_price_staleness_secs
        + 8    // max_price_conf_bps
        + 2    // max_slippage_bps
        + 8 * 5 // min/max deposit, max_trade_usdc, min_stake, min_reserve
        + 8    // timelock_delay_secs
        + 8    // timelock_nonce
        + 8    // pending_change_nonce
        + 1;   // bump

    /// A config change is pending if this is non-zero.
    pub fn has_pending_change(&self) -> bool {
        self.pending_change_nonce != 0
    }
}

/// Per-user vault + strategy state. The PDA address itself is the vault:
/// it holds native SOL and is the token authority of the mSOL / USDC /
/// WSOL vault token accounts.
///
/// Funds can ONLY leave:
/// * via user-signed `withdraw_*` instructions (owner is the sole signer),
/// * via on-chain strategy logic whose every parameter (mints, amounts,
///   slippage vs oracle) is enforced inside this program.
#[account]
pub struct UserPosition {
    /// Sole owner. Only this key can withdraw, start/stop, or close.
    pub owner: Pubkey,
    /// Currently selected strategy.
    pub strategy: StrategyKind,
    /// Set by `start_strategy`; cranks are gated on this.
    pub active: bool,
    /// Self-pause set by the owner (`set_paused`). Blocks cranks only.
    pub paused: bool,
    /// Strategy parameters validated at `start_strategy`.
    pub params: StrategyParams,

    // ---- Staking bookkeeping ----
    /// mSOL held in the vault mSOL ATA (mirrors the token balance).
    pub staked_msol_amount: u64,
    /// Timestamp of the last successful stake operation.
    pub last_stake_ts: i64,

    // ---- Trading bookkeeping ----
    /// WSOL held (mirrors the vault WSOL ATA balance, 9dp).
    pub position_sol_amount: u64,
    /// Weighted average entry price, USDC(6dp) per SOL(9dp).
    pub avg_entry_price: u64,
    /// Cumulative realized PnL in USDC (6dp), signed.
    pub realized_pnl_usdc: i64,
    /// Highest oracle price observed while a position was open (6dp).
    pub high_water_mark: u64,
    /// Earliest timestamp of the next DCA buy.
    pub next_dca_at: i64,
    /// Timestamp of the last executed trade (buy or sell).
    pub last_action_ts: i64,

    /// Lifetime SOL deposits (lamports) — informational accounting only.
    pub total_deposited_lamports: u64,

    /// PDA bump of this account.
    pub bump: u8,
    /// Bump of the companion native-SOL vault PDA (`["vault", owner]`).
    pub vault_bump: u8,
}

impl UserPosition {
    pub const SPACE: usize = 8
        + 32    // owner
        + 3     // strategy, active, paused (1 byte each)
        + StrategyParams::SPACE
        + 8 * 7 // staked_msol, last_stake, pos_sol, avg_entry, pnl, hwm, next_dca
        + 8     // last_action_ts
        + 8     // total_deposited
        + 1     // bump
        + 1;    // vault_bump

    /// USDC(6dp) cost basis of the currently held WSOL.
    pub fn cost_basis_usdc(&self) -> Option<u128> {
        if self.avg_entry_price == 0 {
            return None;
        }
        (self.position_sol_amount as u128)
            .checked_mul(self.avg_entry_price as u128)?
            .checked_div(1_000_000_000u128)
    }
}

/// A queued configuration change. Stored at PDA
/// `["timelock", config, nonce]` and executed after
/// `config.timelock_delay_secs` has elapsed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum ConfigChange {
    /// Change the swap router program (e.g. Jupiter v6 <-> a newer major).
    SetSwapProgram { program: Pubkey },
    /// Re-pin the Marinade integration.
    SetMarinade {
        program: Pubkey,
        state: Pubkey,
        msol_mint: Pubkey,
        treasury: Pubkey,
    },
    /// Re-pin oracle receiver program / feed / staleness / confidence bound.
    SetOracle {
        receiver_program: Pubkey,
        feed_id: [u8; 32],
        staleness_secs: i64,
        conf_bps: u64,
    },
    /// Adjust risk bounds.
    SetRiskBounds {
        max_slippage_bps: u16,
        min_deposit_lamports: u64,
        max_deposit_lamports: u64,
        max_trade_usdc: u64,
        min_stake_lamports: u64,
        min_reserve_lamports: u64,
    },
    /// Replace the guardian set.
    SetGuardians { guardians: [Pubkey; 3] },
    /// Increase the timelock delay (decreases are rejected on-chain).
    SetTimelockDelay { delay_secs: i64 },
}

#[account]
pub struct TimelockEntry {
    /// Admin that proposed the change; must also execute it.
    pub proposer: Pubkey,
    /// Earliest unix timestamp at which `execute_config_change` works.
    pub execute_at: i64,
    /// The queued change.
    pub change: ConfigChange,
    /// Set when executed (account is then closed to reclaim rent).
    pub executed: bool,
    /// PDA bump.
    pub bump: u8,
}

impl TimelockEntry {
    /// Largest variant: SetMarinade = 1 tag + 4 * 32 bytes.
    pub const SPACE: usize = 8 + 32 + 8 + (1 + 32 * 4) + 1 + 1;
}
