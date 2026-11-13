//! User-facing vault instructions.
//!
//! Custody model (non-custodial):
//!
//! * The user's vault is a PDA `["position", owner]` that holds native
//!   SOL lamports and is the authority of three vault token accounts
//!   (mSOL, USDC, WSOL — all ATAs of the position PDA).
//! * The ONLY signer that can move user funds out is the owner, via the
//!   `withdraw_*` instructions in this file. There is no admin
//!   withdrawal path anywhere in this program.
//! * Strategy execution (cranks) can only move funds BETWEEN the vault
//!   and the whitelisted protocol endpoints (Marinade / Jupiter), under
//!   the on-chain guards described in `crank.rs`.

use crate::errors::CypherError;
use crate::events::*;
use crate::math;
use crate::oracle::read_sol_price;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

/// Derive the native-SOL vault PDA: `["vault", owner]` (system-owned).
pub fn native_vault(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, owner.as_ref()], &crate::ID).0
}

/// Signer seeds for the native vault PDA.
pub fn vault_seeds<'a>(owner: &'a Pubkey, bump: &'a u8) -> [&'a [u8]; 3] {
    [VAULT_SEED, owner.as_ref(), std::slice::from_ref(bump)]
}

/// Derive a vault token account (ATA of the position PDA).
pub fn vault_ata(position: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(position, mint, &crate::TOKEN_PROGRAM_ID)
}

/// Open a position. Creates the vault PDA. Strategy may be `None` (set it
/// later via `start_strategy`).
pub fn open_position(ctx: Context<OpenPosition>, strategy: StrategyKind) -> Result<()> {
    let p = &mut ctx.accounts.position;
    p.owner = ctx.accounts.owner.key();
    p.strategy = strategy;
    p.active = false;
    p.paused = false;
    p.params = StrategyParams::default();
    p.staked_msol_amount = 0;
    p.last_stake_ts = 0;
    p.position_sol_amount = 0;
    p.avg_entry_price = 0;
    p.realized_pnl_usdc = 0;
    p.high_water_mark = 0;
    p.next_dca_at = 0;
    p.last_action_ts = 0;
    p.total_deposited_lamports = 0;
    p.bump = ctx.bumps.position;
    p.vault_bump = ctx.bumps.native_vault;

    emit!(PositionOpened {
        owner: p.owner,
        position: ctx.accounts.position.key(),
    });
    Ok(())
}

/// Deposit native SOL into the vault (kept as lamports on the PDA).
/// Works for every strategy. Subject to per-tx min/max bounds.
pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
    require!(
        amount >= ctx.accounts.config.min_deposit_lamports,
        CypherError::DepositTooSmall
    );
    require!(
        amount <= ctx.accounts.config.max_deposit_lamports,
        CypherError::DepositTooLarge
    );

    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.native_vault.to_account_info(),
            },
        ),
        amount,
    )?;

    let p = &mut ctx.accounts.position;
    p.total_deposited_lamports = p
        .total_deposited_lamports
        .checked_add(amount)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;

    emit!(DepositedSol { owner: p.owner, amount_lamports: amount });
    Ok(())
}

/// Deposit SOL into a TRADING position: wraps into the vault WSOL ATA and
/// records it as an immediate entry at the current oracle price (this is
/// a deposit, not a swap — SOL:WSOL is 1:1; the oracle price is only used
/// for honest cost-basis accounting and take-profit/stop-loss math).
pub fn deposit_sol_trading(ctx: Context<DepositSolTrading>, amount: u64) -> Result<()> {
    require!(
        amount >= ctx.accounts.config.min_deposit_lamports,
        CypherError::DepositTooSmall
    );
    require!(
        amount <= ctx.accounts.config.max_deposit_lamports,
        CypherError::DepositTooLarge
    );

    let clock = Clock::get()?;
    let price = read_sol_price(
        &crate::oracle::parse_price_update(
            &ctx.accounts.pyth_price,
            &ctx.accounts.config.pyth_receiver_program,
        )?,
        &clock,
        &ctx.accounts.config,
    )?;

    // 1. lamports: owner -> native vault PDA
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.native_vault.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. wrap: native vault -> WSOL ATA, then sync_native (vault signs)
    let vb = ctx.accounts.position.vault_bump;
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.native_vault.to_account_info(),
                to: ctx.accounts.vault_wsol.to_account_info(),
            },
            &[&vault_seeds(&ctx.accounts.position.owner, &vb)],
        ),
        amount,
    )?;
    token::sync_native(CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        token::SyncNative {
            account: ctx.accounts.vault_wsol.to_account_info(),
        },
    ))?;

    // 3. accounting: entry at the current oracle price (weighted average)
    let p = &mut ctx.accounts.position;
    p.total_deposited_lamports = p
        .total_deposited_lamports
        .checked_add(amount)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;

    let old_amt = p.position_sol_amount as u128;
    let new_amt = old_amt
        .checked_add(amount as u128)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;
    let old_basis = old_amt
        .checked_mul(p.avg_entry_price as u128)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;
    let add_basis = (amount as u128)
        .checked_mul(price as u128)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;
    p.avg_entry_price = math::mul_div(
        old_basis
            .checked_add(add_basis)
            .ok_or_else(|| error!(CypherError::MathOverflow))?,
        1,
        new_amt,
    )? as u64;
    p.position_sol_amount = new_amt as u64;
    if new_amt > 0 && price > p.high_water_mark {
        p.high_water_mark = price;
    }

    emit!(DepositedSol { owner: p.owner, amount_lamports: amount });
    Ok(())
}

/// Deposit the stable-side token (USDC) into the vault.
pub fn deposit_token(ctx: Context<DepositToken>, amount: u64) -> Result<()> {
    require!(amount > 0, CypherError::InvalidParams);
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;
    emit!(DepositedToken {
        owner: ctx.accounts.position.owner,
        mint: ctx.accounts.usdc_mint.key(),
        amount,
    });
    Ok(())
}

/// Withdraw native SOL from the vault. Owner-only. Always allowed, even
/// while globally or self-paused. Leaves the configured reserve in place.
pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
    require!(amount > 0, CypherError::InvalidParams);
    let vault_lamports = ctx.accounts.native_vault.to_account_info().lamports();
    let withdrawable = vault_lamports
        .checked_sub(ctx.accounts.config.min_reserve_lamports)
        .ok_or_else(|| error!(CypherError::InsufficientWithdraw))?;
    require!(amount <= withdrawable, CypherError::InsufficientWithdraw);

    let vb = ctx.accounts.position.vault_bump;
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.native_vault.to_account_info(),
                to: ctx.accounts.owner.to_account_info(),
            },
            &[&vault_seeds(&ctx.accounts.position.owner, &vb)],
        ),
        amount,
    )?;
    emit!(WithdrawnSol { owner: ctx.accounts.position.owner, amount_lamports: amount });
    Ok(())
}

/// Withdraw USDC from the vault to the owner's USDC ATA. Owner-only.
/// Always allowed, even while paused.
pub fn withdraw_usdc(ctx: Context<WithdrawUsdc>, amount: u64) -> Result<()> {
    require!(amount > 0, CypherError::InvalidParams);
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.dest_ata.to_account_info(),
                authority: ctx.accounts.position.to_account_info(),
            },
            &[&[
                POSITION_SEED,
                ctx.accounts.position.owner.as_ref(),
                &[ctx.accounts.position.bump],
            ]],
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;
    emit!(WithdrawnToken {
        owner: ctx.accounts.position.owner,
        mint: ctx.accounts.usdc_mint.key(),
        amount,
    });
    Ok(())
}

/// Withdraw WSOL from the vault to the owner's WSOL ATA. Owner-only.
///
/// Withdrawing WSOL reduces the tracked trading position proportionally
/// (the average entry price is preserved, so PnL accounting stays exact).
pub fn withdraw_wsol(ctx: Context<WithdrawWsol>, amount: u64) -> Result<()> {
    require!(amount > 0, CypherError::InvalidParams);
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_wsol.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                to: ctx.accounts.dest_ata.to_account_info(),
                authority: ctx.accounts.position.to_account_info(),
            },
            &[&[
                POSITION_SEED,
                ctx.accounts.position.owner.as_ref(),
                &[ctx.accounts.position.bump],
            ]],
        ),
        amount,
        ctx.accounts.wsol_mint.decimals,
    )?;

    let p = &mut ctx.accounts.position;
    require!(
        p.position_sol_amount >= amount,
        CypherError::InvariantBroken
    );
    p.position_sol_amount -= amount;
    if p.position_sol_amount == 0 {
        p.avg_entry_price = 0;
        p.high_water_mark = 0;
    }
    emit!(WithdrawnToken {
        owner: p.owner,
        mint: ctx.accounts.wsol_mint.key(),
        amount,
    });
    Ok(())
}

/// Start (or restart) the autonomous strategy. Owner-only.
///
/// For `Trading`, at least one exit rule (take-profit, stop-loss or
/// max-drawdown) must be enabled — the program refuses unbounded
/// strategies. All parameters are validated against global bounds here.
pub fn start_strategy(
    ctx: Context<StartStrategy>,
    strategy: StrategyKind,
    params: StrategyParams,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, CypherError::GlobalPaused);
    require!(strategy != StrategyKind::None, CypherError::InvalidStrategy);
    validate_params(&ctx.accounts.config, strategy, &params)?;

    let clock = Clock::get()?;
    let p = &mut ctx.accounts.position;
    p.strategy = strategy;
    p.params = params;
    p.active = true;
    p.paused = false;

    if strategy == StrategyKind::Trading {
        // Allow the first DCA entry immediately.
        p.next_dca_at = clock.unix_timestamp;
        if p.position_sol_amount == 0 {
            p.avg_entry_price = 0;
            p.high_water_mark = 0;
        }
    } else {
        // Allow the first stake immediately.
        p.last_stake_ts = 0;
    }

    emit!(StrategyStarted { owner: p.owner, strategy });
    Ok(())
}

/// Stop the strategy. Funds remain in the vault; cranks become no-ops.
pub fn stop_strategy(ctx: Context<StopStrategy>) -> Result<()> {
    ctx.accounts.position.active = false;
    emit!(StrategyStopped { owner: ctx.accounts.position.owner });
    Ok(())
}

/// Owner self-pause: blocks the permissionless cranks for this position.
/// Withdrawals remain possible at any time.
pub fn set_paused(ctx: Context<StopStrategy>, paused: bool) -> Result<()> {
    ctx.accounts.position.paused = paused;
    emit!(PositionPaused { owner: ctx.accounts.position.owner, paused });
    Ok(())
}

/// Unstake mSOL back to SOL via Marinade's instant unstake (fee applies
/// inside Marinade). Owner-only. SOL lands in the position PDA.
pub fn unstake_msol(ctx: Context<UnstakeMsol>, msol_amount: u64) -> Result<()> {
    require!(msol_amount > 0, CypherError::InvalidParams);
    let p = &ctx.accounts.position;
    require!(p.staked_msol_amount >= msol_amount, CypherError::UnstakeTooLarge);

    // Defense in depth: verify the Marinade liq-pool accounts really are
    // the PDAs Marinade derives from the configured state.
    verify_marinade_accounts(&ctx.accounts.config, ctx.accounts)?;

    crate::cpi::marinade::marinade_liquid_unstake_cpi(
        &ctx.accounts.marinade_program.to_account_info(),
        &ctx.accounts.marinade_state.to_account_info(),
        &ctx.accounts.msol_mint.to_account_info(),
        &ctx.accounts.liq_pool_sol_leg.to_account_info(),
        &ctx.accounts.liq_pool_msol_leg.to_account_info(),
        &ctx.accounts.treasury_msol.to_account_info(),
        &ctx.accounts.vault_msol.to_account_info(),
        &ctx.accounts.position.to_account_info(), // authority = position PDA
        &[POSITION_SEED, p.owner.as_ref(), &[p.bump]],
        &ctx.accounts.native_vault.to_account_info(), // SOL recipient (vault)
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        msol_amount,
    )?;

    let p = &mut ctx.accounts.position;
    p.staked_msol_amount -= msol_amount;
    emit!(Unstaked { owner: p.owner, msol_burned: msol_amount });
    Ok(())
}

/// Verify that the passed Marinade liq-pool accounts match the PDA
/// derivations Marinade uses for the configured state account.
pub fn verify_marinade_accounts(config: &GlobalConfig, ctx: &UnstakeMsol) -> Result<()> {
    let state = config.marinade_state;
    let program = config.marinade_program;

    let (sol_leg, _b1) =
        Pubkey::find_program_address(&[state.as_ref(), crate::cpi::marinade::LIQ_SOL_LEG_SEED], &program);
    require!(
        ctx.liq_pool_sol_leg.key() == sol_leg,
        CypherError::InvalidMarinadeAccounts
    );

    let (leg_auth, _b2) = Pubkey::find_program_address(
        &[state.as_ref(), crate::cpi::marinade::LIQ_MSOL_LEG_AUTHORITY_SEED],
        &program,
    );
    // (authority account is not part of liquid_unstake accounts, but the
    // mSOL leg is a token account created with seed):
    let msol_leg = Pubkey::create_with_seed(
        &state,
        crate::cpi::marinade::LIQ_MSOL_LEG_SEED,
        &crate::TOKEN_PROGRAM_ID,
    )
    .map_err(|_| error!(CypherError::InvalidMarinadeAccounts))?;
    require!(
        ctx.liq_pool_msol_leg.key() == msol_leg,
        CypherError::InvalidMarinadeAccounts
    );
    let _ = leg_auth;

    Ok(())
}

/// Close the position. Requires: strategy stopped, all token balances
/// zero (mSOL / USDC / WSOL). Remaining native lamports (deposits +
/// rent) go back to the owner.
pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
    let p = &ctx.accounts.position;
    require!(!p.active, CypherError::StrategyStillActive);
    require!(p.staked_msol_amount == 0, CypherError::PositionNotEmpty);
    require!(p.position_sol_amount == 0, CypherError::PositionNotEmpty);
    require!(ctx.accounts.vault_usdc.amount == 0, CypherError::PositionNotEmpty);
    require!(ctx.accounts.vault_wsol.amount == 0, CypherError::PositionNotEmpty);
    require!(ctx.accounts.vault_msol.amount == 0, CypherError::PositionNotEmpty);

    // Drain the native vault (reserve included) to the owner; the empty
    // system account then evaporates at rent collection.
    let vb = p.vault_bump;
    let vault_lamports = ctx.accounts.native_vault.to_account_info().lamports();
    if vault_lamports > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.native_vault.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                &[&vault_seeds(&p.owner, &vb)],
            ),
            vault_lamports,
        )?;
    }

    // Close the three empty vault ATAs back to the owner (position signs).
    let seeds: &[&[&[u8]]] = &[&[POSITION_SEED, p.owner.as_ref(), &[p.bump]]];
    for ata in [
        ctx.accounts.vault_usdc.to_account_info(),
        ctx.accounts.vault_wsol.to_account_info(),
        ctx.accounts.vault_msol.to_account_info(),
    ] {
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::CloseAccount {
                account: ata,
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.position.to_account_info(),
            },
            seeds,
        ))?;
    }

    let pnl = p.realized_pnl_usdc;
    let owner = p.owner;
    // `close = owner` on the position account refunds rent + lamports.
    emit!(PositionClosed { owner, realized_pnl_usdc: pnl });
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Validate strategy parameters against global bounds. All rules are
/// visible here for auditors.
fn validate_params(
    config: &GlobalConfig,
    strategy: StrategyKind,
    params: &StrategyParams,
) -> Result<()> {
    require!(
        params.cycle_secs >= 60 && params.cycle_secs <= 2_592_000,
        CypherError::InvalidParams
    );

    match strategy {
        StrategyKind::Staking => {
            // cycle_secs = minimum interval between stake operations.
            require!(params.trade_amount_usdc == 0, CypherError::InvalidParams);
        }
        StrategyKind::Trading => {
            require!(
                params.trade_amount_usdc >= 1_000_000 // >= 1 USDC
                    && params.trade_amount_usdc <= config.max_trade_usdc,
                CypherError::InvalidParams
            );
            require!(
                params.slippage_bps >= 1 && params.slippage_bps <= config.max_slippage_bps,
                CypherError::InvalidParams
            );
            require!(params.take_profit_bps <= 50_000, CypherError::InvalidParams); // cap: 500% gain
            require!(params.stop_loss_bps <= 10_000, CypherError::InvalidParams); // cap: 100% loss
            require!(params.max_drawdown_bps <= 10_000, CypherError::InvalidParams);
            // At least one exit rule must exist: an unbounded strategy is
            // rejected by design.
            require!(
                params.take_profit_bps > 0
                    || params.stop_loss_bps > 0
                    || params.max_drawdown_bps > 0,
                CypherError::InvalidParams
            );
        }
        StrategyKind::None => return err!(CypherError::InvalidStrategy),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = owner,
        space = UserPosition::SPACE,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, UserPosition>,
    /// Companion native-SOL vault (system-owned, no data). Created lazily
    /// by the first deposit (system transfers fund it directly).
    /// CHECK: PDA of this program, seeds ["vault", owner].
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub native_vault: SystemAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(mut, seeds = [POSITION_SEED, owner.key().as_ref()], bump)]
    pub position: Account<'info, UserPosition>,
    /// CHECK: system-owned native vault PDA ["vault", owner].
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub native_vault: SystemAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSolTrading<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        constraint = position.strategy == StrategyKind::Trading
            @ CypherError::InvalidStrategy
    )]
    pub position: Account<'info, UserPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: system-owned native vault PDA ["vault", owner].
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub native_vault: SystemAccount<'info>,
    /// CHECK: Pyth SOL/USD PriceUpdateV2. Validated in the handler:
    /// owner must be config.pyth_receiver_program and the account must
    /// carry the genuine PriceUpdateV2 discriminator + layout (oracle.rs).
    pub pyth_price: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = wsol_mint,
        associated_token::authority = position
    )]
    pub vault_wsol: Box<Account<'info, TokenAccount>>,
    #[account(address = config.wsol_mint @ CypherError::InvalidMint)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program:
        Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToken<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(seeds = [POSITION_SEED, owner.key().as_ref()], bump)]
    pub position: Account<'info, UserPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(address = config.usdc_mint @ CypherError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = position
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner
    )]
    pub owner_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program:
        Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ CypherError::Unauthorized
    )]
    pub position: Account<'info, UserPosition>,
    /// CHECK: system-owned native vault PDA ["vault", owner].
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub native_vault: SystemAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawUsdc<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ CypherError::Unauthorized
    )]
    pub position: Account<'info, UserPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(address = config.usdc_mint @ CypherError::InvalidMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = position
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner
    )]
    pub dest_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program:
        Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawWsol<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ CypherError::Unauthorized
    )]
    pub position: Account<'info, UserPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(address = config.wsol_mint @ CypherError::InvalidMint)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = position
    )]
    pub vault_wsol: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = wsol_mint,
        associated_token::authority = owner
    )]
    pub dest_ata: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program:
        Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartStrategy<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ CypherError::Unauthorized
    )]
    pub position: Account<'info, UserPosition>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct StopStrategy<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ CypherError::Unauthorized
    )]
    pub position: Account<'info, UserPosition>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnstakeMsol<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ CypherError::Unauthorized
    )]
    pub position: Account<'info, UserPosition>,
    pub owner: Signer<'info>,
    /// CHECK: address-pinned to config.marinade_program.
    #[account(address = config.marinade_program @ CypherError::InvalidMarinadeAccounts)]
    pub marinade_program: UncheckedAccount<'info>,
    /// CHECK: address-pinned to config.marinade_state. Writable: the
    /// Marinade liquid-unstake CPI mutates the state.
    #[account(mut, address = config.marinade_state @ CypherError::InvalidMarinadeAccounts)]
    pub marinade_state: UncheckedAccount<'info>,
    #[account(mut, address = config.msol_mint @ CypherError::InvalidMint)]
    pub msol_mint: Box<Account<'info, Mint>>,
    /// CHECK: Marinade liq-pool SOL leg PDA (re-derived on-chain in the handler).
    #[account(mut)]
    pub liq_pool_sol_leg: UncheckedAccount<'info>,
    /// CHECK: Marinade liq-pool mSOL leg (re-derived on-chain in the handler).
    #[account(mut)]
    pub liq_pool_msol_leg: UncheckedAccount<'info>,
    /// CHECK: Marinade treasury mSOL account (address-pinned to config.msol_treasury).
    #[account(mut, address = config.msol_treasury @ CypherError::InvalidMarinadeAccounts)]
    pub treasury_msol: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = msol_mint,
        associated_token::authority = position
    )]
    pub vault_msol: Box<Account<'info, TokenAccount>>,
    /// CHECK: system-owned native vault PDA ["vault", owner] (SOL recipient).
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub native_vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ CypherError::Unauthorized,
        close = owner
    )]
    pub position: Account<'info, UserPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: system-owned native vault PDA ["vault", owner] (drained here).
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub native_vault: SystemAccount<'info>,
    #[account(
        mut,
        associated_token::mint = config.usdc_mint,
        associated_token::authority = position
    )]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = config.wsol_mint,
        associated_token::authority = position
    )]
    pub vault_wsol: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = config.msol_mint,
        associated_token::authority = position
    )]
    pub vault_msol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
