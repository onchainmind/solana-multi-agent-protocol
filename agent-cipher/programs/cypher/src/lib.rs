//! # Cypher — non-custodial autonomous staking & trading vault
//!
//! A Solana program implementing a per-user non-custodial vault with two
//! selectable "autopilot" strategies:
//!
//! * **Staking** — idle SOL is liquid-staked into Marinade (SOL -> mSOL)
//!   by a permissionless crank. mSOL appreciates against SOL as staking
//!   rewards accrue, so compounding is inherent to the position.
//! * **Trading** — a cycle strategy on the SOL/USDC pair executed through
//!   Jupiter v6: DCA entry while flat, take-profit / stop-loss /
//!   max-drawdown exit while holding. All decision inputs (price,
//!   amounts, bounds) are computed on-chain from a Pyth oracle.
//!
//! ## Custody & security model (short version — see SECURITY.md)
//!
//! * Each user's funds live in their own PDA vault (`["position", owner]`)
//!   plus its token accounts. Only the owner can withdraw.
//! * The cranks are permissionless and trustless: every parameter that
//!   matters (price, slippage, amounts, mints, CPI targets) is enforced
//!   inside this program.
//! * Governance is a timelock: config changes are queued and can be
//!   executed only after the delay. Guardians (multisig) can globally
//!   pause; only the admin can resume.
//! * There is no admin withdrawal, no admin fee and no hidden minting.

pub mod cpi;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

// The #[program] macro expects the generated `__client_accounts_*` modules
// at the crate root — these glob re-exports provide them (standard Anchor
// pattern for context structs living in submodules). The re-exports are
// deliberately ambiguous across modules (shared types like GlobalConfig
// resolve to the same item), so the ambiguity lint is allowed here.
#[allow(ambiguous_glob_reexports)]
pub use instructions::admin::*;
#[allow(ambiguous_glob_reexports)]
pub use instructions::crank::*;
#[allow(ambiguous_glob_reexports)]
pub use instructions::position::*;

use anchor_lang::prelude::*;

/// SPL Token program id (re-exported for context helpers).
pub const TOKEN_PROGRAM_ID: Pubkey = anchor_spl::token::ID;

declare_id!("26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC");

#[program]
pub mod cypher {
    use super::*;

    // ------------------------------------------------------------------
    // Governance / administration
    // ------------------------------------------------------------------

    /// Create the singleton global config. One-time.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        ctx: Context<Initialize>,
        admin: Pubkey,
        guardians: [Pubkey; 3],
        marinade_program: Pubkey,
        marinade_state: Pubkey,
        msol_mint: Pubkey,
        msol_treasury: Pubkey,
        swap_program: Pubkey,
        usdc_mint: Pubkey,
        wsol_mint: Pubkey,
        pyth_receiver_program: Pubkey,
        sol_usd_feed_id: [u8; 32],
        max_price_staleness_secs: i64,
        max_price_conf_bps: u64,
        max_slippage_bps: u16,
        min_deposit_lamports: u64,
        max_deposit_lamports: u64,
        max_trade_usdc: u64,
        min_stake_lamports: u64,
        min_reserve_lamports: u64,
        timelock_delay_secs: i64,
    ) -> Result<()> {
        instructions::admin::initialize(
            ctx,
            admin,
            guardians,
            marinade_program,
            marinade_state,
            msol_mint,
            msol_treasury,
            swap_program,
            usdc_mint,
            wsol_mint,
            pyth_receiver_program,
            sol_usd_feed_id,
            max_price_staleness_secs,
            max_price_conf_bps,
            max_slippage_bps,
            min_deposit_lamports,
            max_deposit_lamports,
            max_trade_usdc,
            min_stake_lamports,
            min_reserve_lamports,
            timelock_delay_secs,
        )
    }

    /// Queue a configuration change behind the timelock. Admin only.
    pub fn propose_config_change(
        ctx: Context<ProposeConfigChange>,
        change: state::ConfigChange,
    ) -> Result<()> {
        instructions::admin::propose_config_change(ctx, change)
    }

    /// Execute the pending change once the delay has elapsed. Admin only.
    pub fn execute_config_change(
        ctx: Context<ExecuteConfigChange>,
    ) -> Result<()> {
        instructions::admin::execute_config_change(ctx)
    }

    /// Cancel the pending change. Admin only.
    pub fn cancel_config_change(
        ctx: Context<CancelConfigChange>,
    ) -> Result<()> {
        instructions::admin::cancel_config_change(ctx)
    }

    /// Two-step admin transfer (step 1: propose).
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::propose_admin(ctx, new_admin)
    }

    /// Two-step admin transfer (step 2: accept, new admin signs).
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::accept_admin(ctx)
    }

    /// Break-glass global pause (admin or any guardian).
    pub fn guardian_pause(ctx: Context<GuardianPause>) -> Result<()> {
        instructions::admin::guardian_pause(ctx)
    }

    /// Resume from global pause (admin only).
    pub fn guardian_resume(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::guardian_resume(ctx)
    }

    // ------------------------------------------------------------------
    // User vault
    // ------------------------------------------------------------------

    /// Open a per-user vault position.
    pub fn open_position(
        ctx: Context<OpenPosition>,
        strategy: state::StrategyKind,
    ) -> Result<()> {
        instructions::position::open_position(ctx, strategy)
    }

    /// Deposit native SOL into the vault.
    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        instructions::position::deposit_sol(ctx, amount)
    }

    /// Deposit SOL into a trading position (wraps to WSOL, records basis).
    pub fn deposit_sol_trading(
        ctx: Context<DepositSolTrading>,
        amount: u64,
    ) -> Result<()> {
        instructions::position::deposit_sol_trading(ctx, amount)
    }

    /// Deposit USDC into the vault.
    pub fn deposit_token(ctx: Context<DepositToken>, amount: u64) -> Result<()> {
        instructions::position::deposit_token(ctx, amount)
    }

    /// Withdraw native SOL. Owner-only, always allowed.
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        instructions::position::withdraw_sol(ctx, amount)
    }

    /// Withdraw USDC. Owner-only, always allowed.
    pub fn withdraw_usdc(ctx: Context<WithdrawUsdc>, amount: u64) -> Result<()> {
        instructions::position::withdraw_usdc(ctx, amount)
    }

    /// Withdraw WSOL. Owner-only, always allowed.
    pub fn withdraw_wsol(ctx: Context<WithdrawWsol>, amount: u64) -> Result<()> {
        instructions::position::withdraw_wsol(ctx, amount)
    }

    /// Select / change the strategy and parameters, and activate it.
    pub fn start_strategy(
        ctx: Context<StartStrategy>,
        strategy: state::StrategyKind,
        params: state::StrategyParams,
    ) -> Result<()> {
        instructions::position::start_strategy(ctx, strategy, params)
    }

    /// Deactivate the strategy (funds stay in the vault).
    pub fn stop_strategy(ctx: Context<StopStrategy>) -> Result<()> {
        instructions::position::stop_strategy(ctx)
    }

    /// Owner self-pause switch (blocks cranks for this position only).
    pub fn set_paused(
        ctx: Context<StopStrategy>,
        paused: bool,
    ) -> Result<()> {
        instructions::position::set_paused(ctx, paused)
    }

    /// Instant-unstake mSOL back to SOL via Marinade. Owner-only.
    pub fn unstake_msol(
        ctx: Context<UnstakeMsol>,
        msol_amount: u64,
    ) -> Result<()> {
        instructions::position::unstake_msol(ctx, msol_amount)
    }

    /// Close the position (must be empty). Owner-only.
    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        instructions::position::close_position(ctx)
    }

    // ------------------------------------------------------------------
    // Permissionless cranks (called by the Cypher agent, or by anyone)
    // ------------------------------------------------------------------

    /// Stake idle vault SOL into Marinade (staking strategy).
    pub fn crank_stake(ctx: Context<CrankStake>) -> Result<()> {
        instructions::crank::crank_stake(ctx)
    }

    /// Execute the trading strategy step (DCA / TP / SL / drawdown).
    pub fn crank_trade<'info>(
        ctx: Context<'_, '_, '_, 'info, CrankTrade<'info>>,
        route_data: Vec<u8>,
    ) -> Result<()> {
        instructions::crank::crank_trade(ctx, route_data)
    }
}
