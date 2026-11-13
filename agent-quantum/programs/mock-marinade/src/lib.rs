//! TEST-ONLY mock of the Marinade liquid-staking CPI surface.
//!
//! This program exists so the cypher staking path can be exercised
//! end-to-end on a local validator without depending on real Marinade
//! accounts. It mirrors the EXACT account order of Marinade's current
//! `deposit(lamports)` and `liquid_unstake(msol_amount)` instructions
//! (see cypher/src/cpi/marinade.rs) and implements the same PDA
//! derivation scheme, so the cypher program's on-chain PDA
//! re-derivation checks are genuinely exercised.
//!
//! Behavior: 1 SOL mints 1 mSOL (rate 1.0), unstake burns 1:1.
//!
//! This program must NEVER be deployed to mainnet and holds no real
//! value. Its keypair is committed under tests/fixtures/ for
//! reproducible localnet tests.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("1XBRVR4Y193YUggzVBFLxmBZhi7ksqUXtPX1nv5L4Ju");

/// Mirrors Marinade LiqPool::MSOL_LEG_AUTHORITY_SEED.
pub const MSOL_LEG_AUTHORITY_SEED: &[u8] = b"liq_st_sol_authority";
/// Mirrors Marinade LiqPool::SOL_LEG_SEED.
pub const SOL_LEG_SEED: &[u8] = b"liq_sol";
/// Mirrors Marinade State::MSOL_MINT_AUTHORITY_SEED.
pub const MINT_AUTHORITY_SEED: &[u8] = b"st_mint";
/// Mirrors Marinade State::RESERVE_SEED.
pub const RESERVE_SEED: &[u8] = b"reserve";

#[program]
pub mod mock_marinade {
    use super::*;

    /// Same account order as Marinade `deposit(lamports)`.
    pub fn deposit(ctx: Context<MockDeposit>, lamports: u64) -> Result<()> {
        // 1. Pull SOL from the caller (position PDA, signed via CPI) into
        //    the "reserve" — exactly like Marinade does for small deposits
        //    when the liq pool is not used.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.transfer_from.to_account_info(),
                    to: ctx.accounts.reserve_pda.to_account_info(),
                },
            ),
            lamports,
        )?;

        // 2. Mint mSOL 1:1 into `mint_to` with Marinade's st_mint PDA
        //    authority (same derivation as the real program).
        let state_key = ctx.accounts.state.key();
        let seeds: &[&[u8]] = &[state_key.as_ref(), MINT_AUTHORITY_SEED, &[ctx.bumps.msol_mint_authority]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.msol_mint.to_account_info(),
                    to: ctx.accounts.mint_to.to_account_info(),
                    authority: ctx.accounts.msol_mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            lamports, // 1:1
        )?;
        Ok(())
    }

    /// Same account order as Marinade `liquid_unstake(msol_amount)`.
    pub fn liquid_unstake(ctx: Context<MockLiquidUnstake>, msol_amount: u64) -> Result<()> {
        // 1. Burn mSOL from the caller's account (caller authority signed
        //    via the outer CPI).
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.msol_mint.to_account_info(),
                    from: ctx.accounts.get_msol_from.to_account_info(),
                    authority: ctx.accounts.get_msol_from_authority.to_account_info(),
                },
            ),
            msol_amount,
        )?;

        // 2. Send SOL from the mock's own liq-pool SOL leg PDA.
        let state_key = ctx.accounts.state.key();
        let seeds: &[&[u8]] = &[state_key.as_ref(), SOL_LEG_SEED, &[ctx.bumps.liq_pool_sol_leg_pda]];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.liq_pool_sol_leg_pda.to_account_info(),
                    to: ctx.accounts.transfer_sol_to.to_account_info(),
                },
                &[seeds],
            ),
            msol_amount, // 1:1
        )?;
        Ok(())
    }

    /// Test helper: set the mSOL mint authority to Marinade's `st_mint`
    /// PDA (as derived for the mock program) so `deposit` can mint.
    /// Caller must be the current authority.
    pub fn set_msol_mint_authority(ctx: Context<SetMintAuthority>) -> Result<()> {
        let state_key = ctx.accounts.state.key();
        let (expected, _bump) =
            Pubkey::find_program_address(&[state_key.as_ref(), MINT_AUTHORITY_SEED], &crate::ID);
        token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::SetAuthority {
                    current_authority: ctx.accounts.current_authority.to_account_info(),
                    account_or_mint: ctx.accounts.msol_mint.to_account_info(),
                },
            ),
            anchor_spl::token::spl_token::instruction::AuthorityType::MintTokens,
            Some(expected),
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct MockDeposit<'info> {
    /// CHECK: any account; the mock only needs its key for PDA seeds.
    pub state: UncheckedAccount<'info>,
    #[account(mut)]
    pub msol_mint: Box<Account<'info, Mint>>,
    /// CHECK: mock liq-pool SOL leg PDA (bump checked via ctx.bumps).
    #[account(mut, seeds = [state.key().as_ref(), SOL_LEG_SEED], bump)]
    pub liq_pool_sol_leg_pda: SystemAccount<'info>,
    #[account(mut)]
    pub liq_pool_msol_leg: Box<Account<'info, TokenAccount>>,
    /// CHECK: mock mSOL leg authority PDA (seeds constrained).
    #[account(seeds = [state.key().as_ref(), MSOL_LEG_AUTHORITY_SEED], bump)]
    pub liq_pool_msol_leg_authority: UncheckedAccount<'info>,
    /// CHECK: mock reserve PDA.
    #[account(mut, seeds = [state.key().as_ref(), RESERVE_SEED], bump)]
    pub reserve_pda: SystemAccount<'info>,
    /// CHECK: SOL source (position PDA, signed via the outer CPI).
    #[account(mut)]
    pub transfer_from: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint_to: Box<Account<'info, TokenAccount>>,
    /// CHECK: mint authority PDA (seeds constrained, signer only).
    #[account(seeds = [state.key().as_ref(), MINT_AUTHORITY_SEED], bump)]
    pub msol_mint_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MockLiquidUnstake<'info> {
    /// CHECK: any account; the mock only needs its key for PDA seeds.
    pub state: UncheckedAccount<'info>,
    #[account(mut)]
    pub msol_mint: Box<Account<'info, Mint>>,
    /// CHECK: mock liq-pool SOL leg PDA (must be pre-funded by tests).
    #[account(mut, seeds = [state.key().as_ref(), SOL_LEG_SEED], bump)]
    pub liq_pool_sol_leg_pda: SystemAccount<'info>,
    #[account(mut)]
    pub liq_pool_msol_leg: Box<Account<'info, TokenAccount>>,
    /// CHECK: treasury (unused by the mock; order-compatible only).
    #[account(mut)]
    pub treasury_msol_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub get_msol_from: Box<Account<'info, TokenAccount>>,
    /// CHECK: caller's authority (position PDA, signed via outer CPI).
    pub get_msol_from_authority: UncheckedAccount<'info>,
    /// CHECK: SOL destination (the caller's vault).
    #[account(mut)]
    pub transfer_sol_to: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetMintAuthority<'info> {
    /// CHECK: any account; the mock only needs its key for PDA derivation.
    pub state: UncheckedAccount<'info>,
    #[account(mut)]
    pub msol_mint: Box<Account<'info, Mint>>,
    /// Must be the current mint authority (the test payer).
    pub current_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
