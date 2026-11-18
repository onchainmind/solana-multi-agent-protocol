//! Admin, guardian and timelock instructions.
//!
//! Governance model:
//!
//! * `admin` — full control over configuration, but every non-trivial
//!   change goes through the timelock (`propose` -> wait -> `execute`).
//! * `guardians` — any single guardian (typically a multisig vault PDA)
//!   can globally pause the protocol. Resuming requires the admin.
//! * Admin transfer is two-step (`propose_admin` / `accept_admin`).

use crate::errors::CypherError;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;

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
    require!(
        max_slippage_bps > 0 && max_slippage_bps <= 2_000,
        CypherError::InvalidParams
    );
    require!(
        min_deposit_lamports <= max_deposit_lamports,
        CypherError::InvalidParams
    );
    require!(timelock_delay_secs >= 0, CypherError::InvalidParams);
    // Single-feed policy: the oracle accepts exactly one receiver program
    // and one feed id; both must be set explicitly at initialize.
    require!(
        pyth_receiver_program != Pubkey::default(),
        CypherError::InvalidParams
    );
    require!(sol_usd_feed_id != [0u8; 32], CypherError::InvalidParams);

    let c = &mut ctx.accounts.config;
    c.admin = admin;
    c.pending_admin = NO_ADMIN;
    c.guardians = guardians;
    c.paused = false;
    c.marinade_program = marinade_program;
    c.marinade_state = marinade_state;
    c.msol_mint = msol_mint;
    c.msol_treasury = msol_treasury;
    c.swap_program = swap_program;
    c.usdc_mint = usdc_mint;
    c.wsol_mint = wsol_mint;
    c.pyth_receiver_program = pyth_receiver_program;
    c.sol_usd_feed_id = sol_usd_feed_id;
    c.max_price_staleness_secs = max_price_staleness_secs;
    c.max_price_conf_bps = max_price_conf_bps;
    c.max_slippage_bps = max_slippage_bps;
    c.min_deposit_lamports = min_deposit_lamports;
    c.max_deposit_lamports = max_deposit_lamports;
    c.max_trade_usdc = max_trade_usdc;
    c.min_stake_lamports = min_stake_lamports;
    c.min_reserve_lamports = min_reserve_lamports;
    c.timelock_delay_secs = timelock_delay_secs;
    c.timelock_nonce = 1;
    c.pending_change_nonce = 0;
    c.bump = ctx.bumps.config;

    emit!(ProtocolInitialized {
        admin,
        marinade_state,
        swap_program,
    });
    Ok(())
}

/// Propose a configuration change. Only the admin. Sets
/// `config.pending_change_nonce` to the created entry.
pub fn propose_config_change(ctx: Context<ProposeConfigChange>, change: ConfigChange) -> Result<()> {
    // Timelock delay may only ever increase.
    if let ConfigChange::SetTimelockDelay { delay_secs } = &change {
        require!(
            *delay_secs > ctx.accounts.config.timelock_delay_secs,
            CypherError::TimelockDelayNotIncreasing
        );
    }
    require!(
        !ctx.accounts.config.has_pending_change(),
        CypherError::TimelockInvalid
    );

    let clock = Clock::get()?;
    let nonce = ctx.accounts.config.timelock_nonce;
    let entry = &mut ctx.accounts.timelock_entry;
    entry.proposer = ctx.accounts.admin.key();
    entry.execute_at = clock.unix_timestamp + ctx.accounts.config.timelock_delay_secs;
    entry.change = change;
    entry.executed = false;
    entry.bump = ctx.bumps.timelock_entry;

    ctx.accounts.config.pending_change_nonce = nonce;
    ctx.accounts.config.timelock_nonce = nonce
        .checked_add(1)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;

    emit!(ConfigChangeProposed {
        nonce,
        execute_at: entry.execute_at,
    });
    Ok(())
}

/// Execute the pending change. Only the proposing admin, only after the
/// delay. Applies the change, marks the entry executed and closes it.
pub fn execute_config_change(ctx: Context<ExecuteConfigChange>) -> Result<()> {
    let clock = Clock::get()?;
    let entry = &mut ctx.accounts.timelock_entry;

    require!(!entry.executed, CypherError::TimelockInvalid);
    require!(
        clock.unix_timestamp >= entry.execute_at,
        CypherError::TimelockNotElapsed
    );
    // The entry's PDA seeds (["timelock", config, config.pending_change_nonce])
    // already cryptographically bind it to the pending nonce; entry.proposer
    // must be the current admin (has_one on config + proposer check below).
    require!(
        entry.proposer == ctx.accounts.config.admin,
        CypherError::Unauthorized
    );

    let config = &mut ctx.accounts.config;
    match entry.change.clone() {
        ConfigChange::SetSwapProgram { program } => {
            config.swap_program = program;
        }
        ConfigChange::SetMarinade {
            program,
            state,
            msol_mint,
            treasury,
        } => {
            config.marinade_program = program;
            config.marinade_state = state;
            config.msol_mint = msol_mint;
            config.msol_treasury = treasury;
        }
        ConfigChange::SetOracle {
            receiver_program,
            feed_id,
            staleness_secs,
            conf_bps,
        } => {
            require!(
                receiver_program != Pubkey::default(),
                CypherError::InvalidParams
            );
            require!(feed_id != [0u8; 32], CypherError::InvalidParams);
            require!(staleness_secs > 0, CypherError::InvalidParams);
            config.pyth_receiver_program = receiver_program;
            config.sol_usd_feed_id = feed_id;
            config.max_price_staleness_secs = staleness_secs;
            config.max_price_conf_bps = conf_bps;
        }
        ConfigChange::SetRiskBounds {
            max_slippage_bps,
            min_deposit_lamports,
            max_deposit_lamports,
            max_trade_usdc,
            min_stake_lamports,
            min_reserve_lamports,
        } => {
            require!(
                max_slippage_bps > 0 && max_slippage_bps <= 2_000,
                CypherError::InvalidParams
            );
            require!(
                min_deposit_lamports <= max_deposit_lamports,
                CypherError::InvalidParams
            );
            config.max_slippage_bps = max_slippage_bps;
            config.min_deposit_lamports = min_deposit_lamports;
            config.max_deposit_lamports = max_deposit_lamports;
            config.max_trade_usdc = max_trade_usdc;
            config.min_stake_lamports = min_stake_lamports;
            config.min_reserve_lamports = min_reserve_lamports;
        }
        ConfigChange::SetGuardians { guardians } => {
            config.guardians = guardians;
        }
        ConfigChange::SetTimelockDelay { delay_secs } => {
            require!(
                delay_secs > config.timelock_delay_secs,
                CypherError::TimelockDelayNotIncreasing
            );
            config.timelock_delay_secs = delay_secs;
        }
    }

    let nonce = config.pending_change_nonce;
    config.pending_change_nonce = 0;
    entry.executed = true;

    emit!(ConfigChangeExecuted { nonce });
    Ok(())
}

/// Cancel a pending change (admin only). Closes the entry.
pub fn cancel_config_change(_ctx: Context<CancelConfigChange>) -> Result<()> {
    let config = &mut _ctx.accounts.config;
    config.pending_change_nonce = 0;
    emit!(ConfigChangeExecuted {
        nonce: 0, // cancelled; nonce 0 signals no active change in indexers
    });
    Ok(())
}

/// Two-step admin transfer, step 1.
pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    emit!(AdminTransferProposed {
        current_admin: ctx.accounts.config.admin,
        pending_admin: new_admin,
    });
    Ok(())
}

/// Two-step admin transfer, step 2. Only the proposed admin can accept.
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let new_admin = ctx.accounts.pending_admin.key();
    ctx.accounts.config.admin = new_admin;
    ctx.accounts.config.pending_admin = NO_ADMIN;
    emit!(AdminTransferred { new_admin });
    Ok(())
}

/// Break-glass global pause. Admin OR any one guardian.
pub fn guardian_pause(ctx: Context<GuardianPause>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let signer = ctx.accounts.authority.key();
    require!(
        signer == config.admin || config.guardians.contains(&signer),
        CypherError::Unauthorized
    );
    config.paused = true;
    emit!(GlobalPaused { by: signer });
    Ok(())
}

/// Resume. Admin only (guardians can stop, only admin restarts).
pub fn guardian_resume(ctx: Context<AdminOnly>) -> Result<()> {
    ctx.accounts.config.paused = false;
    emit!(GlobalResumed {
        by: ctx.accounts.admin.key(),
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = GlobalConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeConfigChange<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CypherError::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = admin,
        space = TimelockEntry::SPACE,
        seeds = [TIMELOCK_SEED, config.key().as_ref(), config.timelock_nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteConfigChange<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.pending_change_nonce != 0 @ CypherError::TimelockInvalid,
        has_one = admin @ CypherError::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    /// Seeds bind this entry to config.pending_change_nonce.
    #[account(
        mut,
        seeds = [TIMELOCK_SEED, config.key().as_ref(), config.pending_change_nonce.to_le_bytes().as_ref()],
        bump,
        close = admin
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelConfigChange<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CypherError::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [TIMELOCK_SEED, config.key().as_ref(), config.pending_change_nonce.to_le_bytes().as_ref()],
        bump,
        close = admin
    )]
    pub timelock_entry: Account<'info, TimelockEntry>,
    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        has_one = admin @ CypherError::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.pending_admin != NO_ADMIN @ CypherError::Unauthorized,
        has_one = pending_admin @ CypherError::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    pub pending_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct GuardianPause<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    pub authority: Signer<'info>,
}
