//! Marinade liquid-staking CPI wrappers.
//!
//! The account order below matches Marinade's current (post 2023 upgrade)
//! IDL exactly:
//!
//! `deposit(lamports)`:            state, msol_mint, liq_pool_sol_leg_pda,
//!   liq_pool_msol_leg, liq_pool_msol_leg_authority, reserve_pda,
//!   transfer_from, mint_to, msol_mint_authority, system_program, token_program
//!
//! `liquid_unstake(msol_amount)`:  state, msol_mint, liq_pool_sol_leg_pda,
//!   liq_pool_msol_leg, treasury_msol_account, get_msol_from,
//!   get_msol_from_authority, transfer_sol_to, system_program, token_program
//!
//! PDA derivations (seeds `[state_bytes, seed]`, program = marinade):
//! * reserve_pda              = b"reserve"
//! * msol_mint_authority      = b"st_mint"
//! * liq_pool_sol_leg_pda     = b"liq_sol"
//! * liq_pool_msol_leg_authority = b"liq_st_sol_authority"
//! * liq_pool_msol_leg        = create_with_seed(state, "liq_st_sol", SPL Token)
//!
//! The instruction contexts in this program validate ALL of these against
//! the configured Marinade state before the CPI is issued, and Marinade's
//! own program re-validates everything on its side.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;

/// sha256("global:deposit")[..8] — Marinade `deposit` discriminator.
pub const MARINADE_DEPOSIT_IX: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
/// sha256("global:liquid_unstake")[..8] — Marinade `liquid_unstake` discriminator.
pub const MARINADE_LIQUID_UNSTAKE_IX: [u8; 8] = [30, 30, 119, 240, 191, 227, 12, 16];

/// Seeds used by Marinade (verified against marinade-finance source).
pub const RESERVE_SEED: &[u8] = b"reserve";
pub const MSOL_MINT_AUTHORITY_SEED: &[u8] = b"st_mint";
pub const LIQ_SOL_LEG_SEED: &[u8] = b"liq_sol";
pub const LIQ_MSOL_LEG_AUTHORITY_SEED: &[u8] = b"liq_st_sol_authority";
pub const LIQ_MSOL_LEG_SEED: &str = "liq_st_sol";

/// Issue `deposit(lamports)`: send `lamports` from the position PDA
/// (signed) to Marinade's reserve, receive mSOL into `mint_to`.
///
/// All account validation happens in the instruction context; this
/// function only builds and invokes.
#[allow(clippy::too_many_arguments)]
pub fn marinade_deposit_cpi<'info>(
    marinade_program: &AccountInfo<'info>,
    marinade_state: &AccountInfo<'info>,
    msol_mint: &AccountInfo<'info>,
    liq_pool_sol_leg: &AccountInfo<'info>,
    liq_pool_msol_leg: &AccountInfo<'info>,
    liq_pool_msol_leg_authority: &AccountInfo<'info>,
    reserve_pda: &AccountInfo<'info>,
    transfer_from: &AccountInfo<'info>, // position PDA (signer)
    transfer_from_seeds: &[&[u8]],
    mint_to: &AccountInfo<'info>, // vault mSOL ATA
    msol_mint_authority: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    let ix = Instruction {
        program_id: *marinade_program.key,
        accounts: vec![
            // state MUST be writable: the deployed mainnet program enforces
            // a `mut` constraint on it (verified by simulation, 2026-11).
            AccountMeta::new(*marinade_state.key, false),
            AccountMeta::new(*msol_mint.key, false),
            AccountMeta::new(*liq_pool_sol_leg.key, false),
            AccountMeta::new(*liq_pool_msol_leg.key, false),
            AccountMeta::new_readonly(*liq_pool_msol_leg_authority.key, false),
            AccountMeta::new(*reserve_pda.key, false),
            AccountMeta::new(*transfer_from.key, true),
            AccountMeta::new(*mint_to.key, false),
            AccountMeta::new_readonly(*msol_mint_authority.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: {
            let mut d = MARINADE_DEPOSIT_IX.to_vec();
            d.extend_from_slice(&lamports.to_le_bytes());
            d
        },
    };

    invoke_signed(
        &ix,
        &[
            marinade_state.clone(),
            msol_mint.clone(),
            liq_pool_sol_leg.clone(),
            liq_pool_msol_leg.clone(),
            liq_pool_msol_leg_authority.clone(),
            reserve_pda.clone(),
            transfer_from.clone(),
            mint_to.clone(),
            msol_mint_authority.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
        &[transfer_from_seeds],
    )
    .map_err(Into::into)
}

/// Issue `liquid_unstake(msol_amount)`: burn mSOL from the vault mSOL ATA
/// (signed by the position PDA) and receive SOL into `transfer_sol_to`
/// (the position PDA), minus Marinade's instant-unstake fee.
#[allow(clippy::too_many_arguments)]
pub fn marinade_liquid_unstake_cpi<'info>(
    marinade_program: &AccountInfo<'info>,
    marinade_state: &AccountInfo<'info>,
    msol_mint: &AccountInfo<'info>,
    liq_pool_sol_leg: &AccountInfo<'info>,
    liq_pool_msol_leg: &AccountInfo<'info>,
    treasury_msol: &AccountInfo<'info>,
    get_msol_from: &AccountInfo<'info>, // vault mSOL ATA
    get_msol_from_authority: &AccountInfo<'info>, // position PDA (signer)
    authority_seeds: &[&[u8]],
    transfer_sol_to: &AccountInfo<'info>, // position PDA
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    msol_amount: u64,
) -> Result<()> {
    let ix = Instruction {
        program_id: *marinade_program.key,
        accounts: vec![
            // state MUST be writable: the deployed mainnet program enforces
            // a `mut` constraint on it (verified by simulation, 2026-11).
            AccountMeta::new(*marinade_state.key, false),
            AccountMeta::new(*msol_mint.key, false),
            AccountMeta::new(*liq_pool_sol_leg.key, false),
            AccountMeta::new(*liq_pool_msol_leg.key, false),
            AccountMeta::new(*treasury_msol.key, false),
            AccountMeta::new(*get_msol_from.key, false),
            AccountMeta::new_readonly(*get_msol_from_authority.key, true),
            AccountMeta::new(*transfer_sol_to.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: {
            let mut d = MARINADE_LIQUID_UNSTAKE_IX.to_vec();
            d.extend_from_slice(&msol_amount.to_le_bytes());
            d
        },
    };

    invoke_signed(
        &ix,
        &[
            marinade_state.clone(),
            msol_mint.clone(),
            liq_pool_sol_leg.clone(),
            liq_pool_msol_leg.clone(),
            treasury_msol.clone(),
            get_msol_from.clone(),
            get_msol_from_authority.clone(),
            transfer_sol_to.clone(),
            system_program.clone(),
            token_program.clone(),
        ],
        &[authority_seeds],
    )
    .map_err(Into::into)
}
