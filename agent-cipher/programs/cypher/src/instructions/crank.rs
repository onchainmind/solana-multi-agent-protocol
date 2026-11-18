//! Permissionless crank instructions — the "autonomous" execution layer.
//!
//! Anyone can submit these transactions (typically the Cypher agent), but
//! NOTHING in them trusts the submitter:
//!
//! * Every action is gated by on-chain state (strategy kind, active,
//!   not paused, cooldown/cycle timing, minimum sizes).
//! * Staking: the program decides the amount (idle lamports above the
//!   reserve), validates every Marinade PDA by re-deriving it, and
//!   records the minted mSOL.
//! * Trading: the program reads the Pyth oracle itself, decides whether
//!   a DCA buy or a TP/SL/drawdown sell is due, enforces exact-input and
//!   an oracle-anchored minimum output on the swap, and forbids any
//!   route account from being a vault account.

use crate::cpi::jupiter::{SwapSide, JUP_EVENT_AUTHORITY_SEED};
use crate::cpi::marinade as mnde;
use crate::errors::CypherError;
use crate::events::*;
use crate::math;
use crate::oracle::{parse_price_update, read_sol_price};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{Token, TokenAccount};
use anchor_spl::token::spl_token;

/// Trade execution reasons (mirrors `TradeExecuted.reason`).
pub const REASON_DCA: u8 = 0;
pub const REASON_TAKE_PROFIT: u8 = 1;
pub const REASON_STOP_LOSS: u8 = 2;
pub const REASON_MAX_DRAWDOWN: u8 = 3;

// ---------------------------------------------------------------------------
// crank_stake — staking strategy executor
// ---------------------------------------------------------------------------

/// Stake idle native SOL (above the reserve) into Marinade.
///
/// Permissionless. Callable only when the position is an ACTIVE staking
/// position, nothing is paused, and the per-position cooldown has
/// elapsed. If there is not enough idle SOL it emits `NothingStaked`
/// (success) so agents can move on without failed transactions.
pub fn crank_stake(ctx: Context<CrankStake>) -> Result<()> {
    let config = &ctx.accounts.config;
    let position = &ctx.accounts.position; // immutable first (mutated at the end)
    let clock = Clock::get()?;

    require!(!config.paused, CypherError::GlobalPaused);
    require!(position.active, CypherError::StrategyNotActive);
    require!(!position.paused, CypherError::PositionPaused);
    require!(
        position.strategy == StrategyKind::Staking,
        CypherError::InvalidStrategy
    );

    // Cooldown: params.cycle_secs is the minimum stake interval.
    if position.last_stake_ts != 0 {
        require!(
            clock.unix_timestamp
                >= position.last_stake_ts.saturating_add(position.params.cycle_secs),
            CypherError::CooldownActive
        );
    }

    // Amount decision is made ON-CHAIN: everything above the reserve.
    let vault_lamports = ctx.accounts.native_vault.to_account_info().lamports();
    let stakeable = vault_lamports
        .checked_sub(config.min_reserve_lamports)
        .ok_or_else(|| error!(CypherError::StakeTooSmall))?;

    if stakeable < config.min_stake_lamports {
        emit!(NothingStaked { owner: position.owner });
        return Ok(());
    }

    // Verify all Marinade PDAs by re-deriving them (defense in depth;
    // Marinade re-validates on its side too).
    verify_marinade_pdas(config, ctx.accounts)?;

    let msol_before = ctx.accounts.vault_msol.amount;
    let owner = position.owner;
    let vault_bump = position.vault_bump;

    mnde::marinade_deposit_cpi(
        &ctx.accounts.marinade_program.to_account_info(),
        &ctx.accounts.marinade_state.to_account_info(),
        &ctx.accounts.msol_mint.to_account_info(),
        &ctx.accounts.liq_pool_sol_leg.to_account_info(),
        &ctx.accounts.liq_pool_msol_leg.to_account_info(),
        &ctx.accounts.liq_pool_msol_leg_authority.to_account_info(),
        &ctx.accounts.reserve_pda.to_account_info(),
        &ctx.accounts.native_vault.to_account_info(), // transfer_from (signer)
        &[VAULT_SEED, owner.as_ref(), &[vault_bump]],
        &ctx.accounts.vault_msol.to_account_info(), // mint_to
        &ctx.accounts.msol_mint_authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        stakeable,
    )?;

    // Reload vault mSOL balance and account for the minted amount.
    let msol_after = {
        let ai = ctx.accounts.vault_msol.to_account_info();
        let data = ai.try_borrow_data()?;
        spl_token::state::Account::unpack(&data)
            .map_err(|_| error!(CypherError::InvariantBroken))?
            .amount
    };
    let minted = msol_after.saturating_sub(msol_before);
    require!(minted > 0, CypherError::EmptySwapOutput);

    // Mutable phase: everything verified, apply the state changes.
    let position = &mut ctx.accounts.position;
    position.staked_msol_amount = position
        .staked_msol_amount
        .checked_add(minted)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;
    position.last_stake_ts = clock.unix_timestamp;

    emit!(Staked {
        owner: position.owner,
        lamports: stakeable,
        msol_minted: minted,
        total_msol: position.staked_msol_amount,
    });
    Ok(())
}

/// Re-derive and verify every Marinade PDA against the configured state.
fn verify_marinade_pdas(config: &GlobalConfig, ctx: &CrankStake) -> Result<()> {
    let state = config.marinade_state;
    let program = config.marinade_program;

    let (sol_leg, _) = Pubkey::find_program_address(
        &[state.as_ref(), mnde::LIQ_SOL_LEG_SEED],
        &program,
    );
    require!(
        ctx.liq_pool_sol_leg.key() == sol_leg,
        CypherError::InvalidMarinadeAccounts
    );

    let msol_leg = Pubkey::create_with_seed(&state, mnde::LIQ_MSOL_LEG_SEED, &spl_token::ID)
        .map_err(|_| error!(CypherError::InvalidMarinadeAccounts))?;
    require!(
        ctx.liq_pool_msol_leg.key() == msol_leg,
        CypherError::InvalidMarinadeAccounts
    );

    let (leg_auth, _) = Pubkey::find_program_address(
        &[state.as_ref(), mnde::LIQ_MSOL_LEG_AUTHORITY_SEED],
        &program,
    );
    require!(
        ctx.liq_pool_msol_leg_authority.key() == leg_auth,
        CypherError::InvalidMarinadeAccounts
    );

    let (reserve, _) = Pubkey::find_program_address(&[state.as_ref(), mnde::RESERVE_SEED], &program);
    require!(ctx.reserve_pda.key() == reserve, CypherError::InvalidMarinadeAccounts);

    let (mint_auth, _) = Pubkey::find_program_address(
        &[state.as_ref(), mnde::MSOL_MINT_AUTHORITY_SEED],
        &program,
    );
    require!(
        ctx.msol_mint_authority.key() == mint_auth,
        CypherError::InvalidMarinadeAccounts
    );

    Ok(())
}

#[derive(Accounts)]
pub struct CrankStake<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    /// CHECK: system-owned native vault PDA ["vault", owner] (SOL source).
    #[account(mut, seeds = [VAULT_SEED, owner.key().as_ref()], bump)]
    pub native_vault: SystemAccount<'info>,
    /// CHECK: permissionless crank; constrained to position.owner below.
    #[account(
        constraint = owner.key() == position.owner @ CypherError::Unauthorized
    )]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, UserPosition>,
    /// CHECK: address-pinned to config.marinade_program.
    #[account(address = config.marinade_program @ CypherError::InvalidMarinadeAccounts)]
    pub marinade_program: UncheckedAccount<'info>,
    /// CHECK: address-pinned to config.marinade_state. Writable: the
    /// Marinade deposit CPI mutates the state (oracle/pricing fields).
    #[account(mut, address = config.marinade_state @ CypherError::InvalidMarinadeAccounts)]
    pub marinade_state: UncheckedAccount<'info>,
    /// CHECK: address-pinned to config.msol_mint (writable: Marinade mints).
    #[account(mut, address = config.msol_mint @ CypherError::InvalidMint)]
    pub msol_mint: UncheckedAccount<'info>,
    /// CHECK: Marinade liq-pool SOL leg PDA (re-derived on-chain in the handler).
    #[account(mut)]
    pub liq_pool_sol_leg: UncheckedAccount<'info>,
    /// CHECK: Marinade liq-pool mSOL leg (re-derived on-chain in the handler).
    #[account(mut)]
    pub liq_pool_msol_leg: UncheckedAccount<'info>,
    /// CHECK: Marinade liq-pool mSOL leg authority PDA (re-derived in the handler).
    pub liq_pool_msol_leg_authority: UncheckedAccount<'info>,
    /// CHECK: Marinade reserve PDA (re-derived on-chain in the handler).
    #[account(mut)]
    pub reserve_pda: UncheckedAccount<'info>,
    /// CHECK: Marinade mSOL mint authority PDA (re-derived in the handler).
    pub msol_mint_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = msol_mint,
        associated_token::authority = position
    )]
    pub vault_msol: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// crank_trade — trading strategy executor
// ---------------------------------------------------------------------------

/// Execute the trading strategy: DCA entry when flat and due; exit on
/// take-profit, stop-loss or max-drawdown while holding.
///
/// Permissionless. The submitter supplies the Pyth price account and the
/// Jupiter route (accounts + payload) but cannot choose amounts or
/// prices: everything decision-relevant is computed on-chain.
pub fn crank_trade<'info>(
    ctx: Context<'_, '_, '_, 'info, CrankTrade<'info>>,
    route_data: Vec<u8>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let position = &ctx.accounts.position; // immutable first (mutated at the end)
    let clock = Clock::get()?;

    require!(!config.paused, CypherError::GlobalPaused);
    require!(position.active, CypherError::StrategyNotActive);
    require!(!position.paused, CypherError::PositionPaused);
    require!(
        position.strategy == StrategyKind::Trading,
        CypherError::InvalidStrategy
    );

    let price = read_sol_price(
        &parse_price_update(&ctx.accounts.pyth_price, &config.pyth_receiver_program)?,
        &clock,
        config,
    )?;

    // Vault balance snapshots.
    let wsol_before = ctx.accounts.vault_wsol.amount;
    let usdc_before = ctx.accounts.vault_usdc.amount;

    // Invariant: tracked WSOL position must equal the vault WSOL balance.
    require!(
        wsol_before == position.position_sol_amount,
        CypherError::InvariantBroken
    );

    // ---- Decide the action (fully on-chain, read-only) ---------------------
    // High water mark is evaluated as max(stored, price) without mutating
    // yet; the update is applied in the final mutation phase.
    let hwm = position.high_water_mark.max(price);
    let mut action: Option<(SwapSide, u64, u8)> = None; // (side, amount_in, reason)

    if wsol_before > 0 {
        let avg = position.avg_entry_price as u128;
        require!(avg > 0, CypherError::InvariantBroken);

        let tp_trigger = avg
            .checked_add(math::bp_mul(avg, position.params.take_profit_bps)?)
            .ok_or_else(|| error!(CypherError::MathOverflow))?;
        let sl_trigger = avg.saturating_sub(math::bp_mul(avg, position.params.stop_loss_bps)?);
        let dd_trigger = (hwm as u128).saturating_sub(math::bp_mul(
            hwm as u128,
            position.params.max_drawdown_bps,
        )?);

        let p = price as u128;
        let reason = if position.params.take_profit_bps > 0 && p >= tp_trigger {
            Some(REASON_TAKE_PROFIT)
        } else if position.params.stop_loss_bps > 0 && p <= sl_trigger {
            Some(REASON_STOP_LOSS)
        } else if position.params.max_drawdown_bps > 0 && p <= dd_trigger {
            Some(REASON_MAX_DRAWDOWN)
        } else {
            None
        };

        if let Some(reason) = reason {
            // Sell the FULL WSOL balance.
            action = Some((SwapSide::Sell, wsol_before, reason));
        }
    } else {
        // Flat: DCA entry when due and affordable.
        let due = clock.unix_timestamp >= position.next_dca_at;
        let affordable = usdc_before >= position.params.trade_amount_usdc;
        if due && affordable && position.params.trade_amount_usdc > 0 {
            action = Some((SwapSide::Buy, position.params.trade_amount_usdc, REASON_DCA));
        }
    }

    let Some((side, amount_in, reason)) = action else {
        // No trade due: still persist the high-water-mark update so
        // drawdown stays accurate between cranks.
        let stored_hwm = position.high_water_mark;
        let owner_key = position.owner;
        if hwm != stored_hwm {
            let p = &mut ctx.accounts.position;
            p.high_water_mark = hwm;
        }
        emit!(NothingToDo { owner: owner_key });
        return Ok(());
    };

    // ---- Validate swap accounts + route guard -----------------------------
    validate_swap_accounts(config, &position.key(), ctx.accounts, ctx.remaining_accounts, side)?;

    let owner = position.owner;
    let bump = position.bump;

    // ---- Execute -----------------------------------------------------------
    crate::cpi::jupiter::jupiter_route_cpi(
        &ctx.accounts.swap_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.position.to_account_info(),
        &[POSITION_SEED, owner.as_ref(), &[bump]],
        &ctx.accounts.jup_src_ta.to_account_info(),
        &ctx.accounts.jup_dst_ta.to_account_info(),
        &ctx.accounts.jup_destination_token_account.to_account_info(),
        &ctx.accounts.jup_dst_mint.to_account_info(),
        &ctx.accounts.jup_platform_fee_account.to_account_info(),
        &ctx.accounts.jup_event_authority.to_account_info(),
        &ctx.accounts.jup_program_acct.to_account_info(),
        ctx.remaining_accounts,
        &route_data,
    )?;

    // Re-read the vault token accounts after the CPI (anchor caches the
    // deserialized copy created at context setup).
    ctx.accounts.vault_usdc.reload()?;
    ctx.accounts.vault_wsol.reload()?;

    // ---- Post-trade accounting (mutable phase) -----------------------------
    let wsol_after = ctx.accounts.vault_wsol.amount;
    let usdc_after = ctx.accounts.vault_usdc.amount;

    let position = &mut ctx.accounts.position;
    match side {
        SwapSide::Buy => {
            // Exact input.
            let usdc_spent = usdc_before
                .checked_sub(usdc_after)
                .ok_or_else(|| error!(CypherError::InvariantBroken))?;
            require!(
                usdc_spent == position.params.trade_amount_usdc,
                CypherError::InvalidSwapAccounts
            );
            let bought = wsol_after
                .checked_sub(wsol_before)
                .ok_or_else(|| error!(CypherError::InvariantBroken))?;
            require!(bought > 0, CypherError::EmptySwapOutput);

            // Oracle-anchored output floor.
            let expected = math::usdc_to_sol(amount_in, price)?;
            let min_out = math::apply_slippage_down(expected, position.params.slippage_bps)?;
            require!(
                bought as u128 >= min_out,
                CypherError::SlippageExceeded
            );

            // Entry at ACTUAL fill price: amount_in / bought.
            let avg = math::mul_div(amount_in as u128, math::SOL_SCALE, bought as u128)?;
            position.position_sol_amount = bought;
            position.avg_entry_price = avg as u64;
            position.high_water_mark = hwm.max(price);
            position.next_dca_at = clock
                .unix_timestamp
                .saturating_add(position.params.cycle_secs);
            position.last_action_ts = clock.unix_timestamp;

            emit!(TradeExecuted {
                owner: position.owner,
                is_buy: true,
                amount_in,
                amount_out: bought,
                oracle_price: price,
                avg_entry_price: avg as u64,
                reason,
            });
        }
        SwapSide::Sell => {
            // Exact input: the full tracked WSOL position.
            let sold = wsol_before
                .checked_sub(wsol_after)
                .ok_or_else(|| error!(CypherError::InvariantBroken))?;
            require!(sold == wsol_before, CypherError::InvalidSwapAccounts);
            let received = usdc_after
                .checked_sub(usdc_before)
                .ok_or_else(|| error!(CypherError::InvariantBroken))?;

            let expected = math::sol_to_usdc(wsol_before, price)?;
            let min_out = math::apply_slippage_down(expected, position.params.slippage_bps)?;
            require!(
                received as u128 >= min_out,
                CypherError::SlippageExceeded
            );

            // Realized PnL vs cost basis.
            let basis = position
                .cost_basis_usdc()
                .ok_or_else(|| error!(CypherError::InvariantBroken))?;
            let pnl = (received as i128)
                .checked_sub(basis as i128)
                .ok_or_else(|| error!(CypherError::MathOverflow))?;
            position.realized_pnl_usdc = position
                .realized_pnl_usdc
                .checked_add(pnl as i64)
                .ok_or_else(|| error!(CypherError::MathOverflow))?;

            position.position_sol_amount = 0;
            position.avg_entry_price = 0;
            position.high_water_mark = hwm.max(price);
            position.next_dca_at = clock
                .unix_timestamp
                .saturating_add(position.params.cycle_secs);
            position.last_action_ts = clock.unix_timestamp;

            let flatten_pause = reason == REASON_MAX_DRAWDOWN;
            if flatten_pause {
                position.paused = true; // circuit breaker: user must resume
            }

            emit!(TradeExecuted {
                owner: position.owner,
                is_buy: false,
                amount_in: wsol_before,
                amount_out: received,
                oracle_price: price,
                avg_entry_price: 0,
                reason,
            });
            emit!(Flattened { owner: position.owner, reason, position_paused: flatten_pause });
        }
    }

    Ok(())
}

/// Enforce every swap-account guard before the CPI:
/// * src / dst are the vault ATAs in the right order for the side,
/// * destination mint is the whitelist mint,
/// * swap program + its event authority are genuine,
/// * no route account is a vault-controlled account.
fn validate_swap_accounts<'info>(
    config: &GlobalConfig,
    position_key: &Pubkey,
    accounts: &CrankTrade<'info>,
    remaining: &[AccountInfo<'info>],
    side: SwapSide,
) -> Result<()> {
    let vault_usdc = vault_ata_pub(position_key, &config.usdc_mint);
    let vault_wsol = vault_ata_pub(position_key, &config.wsol_mint);
    let vault_msol = vault_ata_pub(position_key, &config.msol_mint);
    let (native_vault, _) = Pubkey::find_program_address(
        &[VAULT_SEED, accounts.owner.key().as_ref()],
        &crate::ID,
    );

    // 1. swap program identity.
    require!(
        accounts.swap_program.key() == config.swap_program,
        CypherError::InvalidSwapAccounts
    );
    require!(
        accounts.jup_program_acct.key() == config.swap_program,
        CypherError::InvalidSwapAccounts
    );

    // 2. event authority must be the real PDA of the swap program.
    let (event_auth, _) = Pubkey::find_program_address(
        &[JUP_EVENT_AUTHORITY_SEED],
        &config.swap_program,
    );
    require!(
        accounts.jup_event_authority.key() == event_auth,
        CypherError::InvalidSwapAccounts
    );

    // 3. source / destination routing by side.
    match side {
        SwapSide::Buy => {
            require!(
                accounts.jup_src_ta.key() == vault_usdc,
                CypherError::InvalidSwapAccounts
            );
            require!(
                accounts.jup_dst_ta.key() == vault_wsol,
                CypherError::InvalidSwapAccounts
            );
            require!(
                accounts.jup_dst_mint.key() == config.wsol_mint,
                CypherError::InvalidSwapAccounts
            );
        }
        SwapSide::Sell => {
            require!(
                accounts.jup_src_ta.key() == vault_wsol,
                CypherError::InvalidSwapAccounts
            );
            require!(
                accounts.jup_dst_ta.key() == vault_usdc,
                CypherError::InvalidSwapAccounts
            );
            require!(
                accounts.jup_dst_mint.key() == config.usdc_mint,
                CypherError::InvalidSwapAccounts
            );
        }
    }

    // 4. Pass-through and route accounts must never include any vault-controlled account.
    let forbidden_keys = [vault_usdc, vault_wsol, vault_msol, native_vault, *position_key];
    require!(
        !forbidden_keys.contains(&accounts.jup_destination_token_account.key()),
        CypherError::InvalidSwapAccounts
    );
    require!(
        !forbidden_keys.contains(&accounts.jup_platform_fee_account.key()),
        CypherError::InvalidSwapAccounts
    );

    for a in remaining {
        let k = a.key();
        require!(
            !forbidden_keys.contains(&k),
            CypherError::InvalidSwapAccounts
        );
    }

    Ok(())
}

/// Vault ATA derivation helper (kept local so both position.rs and
/// crank.rs can use it without import churn).
pub fn vault_ata_pub(position: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(position, mint, &spl_token::ID)
}

#[derive(Accounts)]
pub struct CrankTrade<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, GlobalConfig>,
    /// Permissionless: no signer. CHECK: constrained to position.owner.
    #[account(
        constraint = owner.key() == position.owner @ CypherError::Unauthorized
    )]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [POSITION_SEED, owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, UserPosition>,
    /// CHECK: Pyth SOL/USD PriceUpdateV2. Validated in the handler:
    /// owner must be config.pyth_receiver_program and the account must
    /// carry the genuine PriceUpdateV2 discriminator + layout (oracle.rs).
    pub pyth_price: UncheckedAccount<'info>,
    /// CHECK: address-pinned to config.swap_program (verified in the handler).
    pub swap_program: UncheckedAccount<'info>,
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
    /// CHECK: Jupiter user source token account (validated against the vault ATA in the handler).
    #[account(mut)]
    pub jup_src_ta: UncheckedAccount<'info>,
    /// CHECK: Jupiter user destination token account (validated against the vault ATA in the handler).
    #[account(mut)]
    pub jup_dst_ta: UncheckedAccount<'info>,
    /// CHECK: Jupiter destination mint (validated against config mints in
    /// the handler; writable because burn/mint routes mutate the mint).
    #[account(mut)]
    pub jup_dst_mint: UncheckedAccount<'info>,
    /// CHECK: Jupiter v6 `destinationTokenAccount` slot — pass-through:
    /// for plain token-to-token swaps the real Jupiter puts a dummy here
    /// (its own program id). Never validated because the vault balances
    /// (exact-input + oracle min-out) are enforced on-chain regardless.
    #[account(mut)]
    pub jup_destination_token_account: UncheckedAccount<'info>,
    /// CHECK: Jupiter v6 `platformFeeAccount` slot — pass-through; the
    /// route payload must carry platform_fee_bps == 0 (checked on-chain)
    /// so no fee can ever be diverted to this account.
    #[account(mut)]
    pub jup_platform_fee_account: UncheckedAccount<'info>,
    /// CHECK: Jupiter event authority (PDA re-derived on-chain in the handler).
    pub jup_event_authority: UncheckedAccount<'info>,
    /// CHECK: Jupiter program self-account (pinned to config.swap_program in the handler).
    pub jup_program_acct: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // `ctx.remaining_accounts` = Jupiter route accounts (guard-checked).
}
