//! Jupiter v6 `route` CPI wrapper (raw pass-through with on-chain guards).
//!
//! Design (this is the crux of the trading strategy's safety):
//!
//! The client (SDK / agent) fetches a Jupiter quote and serializes the
//! swap route payload off-chain (route_plan, in_amount, quoted_out_amount,
//! slippage_bps, platform_fee_bps). The program does NOT trust that
//! payload. Instead it enforces, fully on-chain:
//!
//! 1. `swap_program` must equal `config.swap_program` (pinned at init,
//!    changeable only via timelock).
//! 2. The two token accounts Jupiter swaps between MUST be the position's
//!    own vault ATAs (USDC -> WSOL for buys, WSOL -> USDC for sells).
//! 3. The destination mint must be the expected whitelist mint.
//! 4. Jupiter's event authority must be the real PDA of the swap program.
//! 5. None of the route (remaining) accounts may be the position PDA or
//!    any vault ATA — route accounts can never touch vault funds.
//! 6. Exact input: the source ATA balance must drop by EXACTLY the
//!    planned amount (full WSOL balance for sells, the configured DCA
//!    amount for buys).
//! 7. Oracle-anchored output floor: the destination ATA must receive at
//!    least `expected_out(oracle_price) * (1 - slippage_bps)`. The quoted
//!    price inside the client payload is irrelevant.
//!
//!
//! Any deviation reverts the whole transaction (Solana atomicity), so a
//! hostile or buggy route can never partially extract funds.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;

/// sha256("global:route")[..8] — Jupiter v6 `route` discriminator
/// (verified against jup-ag/jupiter-cpi).
pub const JUP_ROUTE_IX: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];

/// Seed of Jupiter's event authority PDA.
pub const JUP_EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

/// Hard cap on serialized route payload size (bytes).
pub const MAX_ROUTE_DATA_LEN: usize = 2048;

/// Which side of the SOL/USDC pair we are trading (program-internal).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SwapSide {
    /// USDC -> WSOL (DCA buy).
    Buy,
    /// WSOL -> USDC (take-profit / stop-loss / drawdown sell).
    Sell,
}

/// Issue the Jupiter `route` CPI.
///
/// Account layout = Jupiter v6 `route` EXACTLY (jup-ag/jupiter-cpi
/// idl.json, verified against real mainnet route instructions):
///
/// ```text
/// 0 tokenProgram                 (ro)
/// 1 userTransferAuthority        (signer)  = position PDA
/// 2 userSourceTokenAccount       (mut)     = vault src ATA
/// 3 userDestinationTokenAccount  (mut)     = vault dst ATA
/// 4 destinationTokenAccount      (mut)     = pass-through (jup uses a
///                                            dummy for plain swaps)
/// 5 destinationMint              (mut)     = whitelist mint
/// 6 platformFeeAccount           (mut)     = pass-through (must carry
///                                            platform_fee_bps == 0)
/// 7 eventAuthority               (ro)      = __event_authority PDA
/// 8 program                      (ro)      = swap program self-account
/// 9.. route accounts                       = ctx.remaining_accounts
/// ```
///
/// `route_accounts` = `ctx.remaining_accounts` (the AMM route accounts),
/// which the caller must already have guard-checked (rule 5 above).
/// `token_program_info` is the SPL Token program `AccountInfo`.
#[allow(clippy::too_many_arguments)]
pub fn jupiter_route_cpi<'info>(
    swap_program: &AccountInfo<'info>,
    token_program_info: &AccountInfo<'info>,
    user_transfer_authority: &AccountInfo<'info>, // position PDA
    authority_seeds: &[&[u8]],
    src_ta: &AccountInfo<'info>,
    dst_ta: &AccountInfo<'info>,
    destination_token_account: &AccountInfo<'info>,
    dst_mint: &AccountInfo<'info>,
    platform_fee_account: &AccountInfo<'info>,
    event_authority: &AccountInfo<'info>,
    program_acct: &AccountInfo<'info>,
    route_accounts: &[AccountInfo<'info>],
    route_data: &[u8],
) -> Result<()> {
    require!(
        route_data.len() <= MAX_ROUTE_DATA_LEN,
        crate::errors::CypherError::RouteDataTooLarge
    );
    // The route payload must contain the fixed tail:
    // in_amount(u64) + quoted_out_amount(u64) + slippage_bps(u16)
    // + platform_fee_bps(u8) = 19 bytes.
    require!(
        route_data.len() >= 19,
        crate::errors::CypherError::InvalidSwapAccounts
    );
    // Anti-fee-extraction: the payload's platform_fee_bps (last byte)
    // must be zero, so Jupiter can never divert part of the output to
    // an arbitrary "platform fee" account chosen by the submitter.
    require!(
        route_data[route_data.len() - 1] == 0,
        crate::errors::CypherError::InvalidSwapAccounts
    );

    let mut metas = vec![
        AccountMeta::new_readonly(*token_program_info.key, false), // 0 tokenProgram
        AccountMeta::new_readonly(*user_transfer_authority.key, true), // 1 userTransferAuthority (signer)
        AccountMeta::new(*src_ta.key, false),                      // 2 userSourceTokenAccount
        AccountMeta::new(*dst_ta.key, false),                      // 3 userDestinationTokenAccount
        AccountMeta::new(*destination_token_account.key, false),   // 4 destinationTokenAccount
        AccountMeta::new(*dst_mint.key, false),                    // 5 destinationMint
        AccountMeta::new(*platform_fee_account.key, false),        // 6 platformFeeAccount
        AccountMeta::new_readonly(*event_authority.key, false),    // 7 eventAuthority
        AccountMeta::new_readonly(*program_acct.key, false),       // 8 program
    ];
    // Route accounts: pass through as writable/non-signer. Security is
    // enforced by the vault-account exclusion guard, exact-input and
    // oracle-anchored min-output checks, NOT by trusting this list.
    for a in route_accounts {
        metas.push(AccountMeta::new(*a.key, false));
    }

    let mut data = JUP_ROUTE_IX.to_vec();
    data.extend_from_slice(route_data);

    let ix = Instruction {
        program_id: *swap_program.key,
        accounts: metas,
        data,
    };

    let mut infos = vec![
        token_program_info.clone(),
        user_transfer_authority.clone(),
        src_ta.clone(),
        dst_ta.clone(),
        destination_token_account.clone(),
        dst_mint.clone(),
        platform_fee_account.clone(),
        event_authority.clone(),
        program_acct.clone(),
    ];
    for a in route_accounts {
        infos.push(a.clone());
    }

    invoke_signed(&ix, &infos, &[authority_seeds]).map_err(Into::into)
}
