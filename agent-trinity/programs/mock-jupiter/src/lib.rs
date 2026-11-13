//! TEST-ONLY mock of the Jupiter v6 `route` swap surface.
//!
//! The instruction is named `route`, so anchor derives the same 8-byte
//! discriminator as the real Jupiter program
//! (sha256("global:route")[..8] = e517cb977ae3ad2a), and the fixed
//! account order matches Jupiter v6's `route` accounts EXACTLY
//! (per jup-ag/jupiter-cpi idl.json):
//!   tokenProgram, userTransferAuthority, userSourceTokenAccount,
//!   userDestinationTokenAccount, destinationTokenAccount,
//!   destinationMint, platformFeeAccount, eventAuthority, program,
//!   ...route accounts.
//! The cypher program's guards are therefore exercised against a
//! realistic interface.
//!
//! Fill model: the mock BURNS the input tokens from the source account
//! (the caller's authority is signed via the outer CPI, exactly like the
//! real flow) and MINTS the output tokens to the destination account at
//! its own fixed price. The output mint's authority must therefore be
//! the mock's `["mock_mint_auth"]` PDA (tests set this up).
//!
//! Pricing: remaining_accounts[0] = the mock price-state PDA (`["price"]`,
//! USDC-6dp per SOL, set by tests), remaining_accounts[1] = the SOURCE
//! mint account (needed for burn).
//!   * source decimals 9 (WSOL) -> out = in * price / 1e9 (USDC 6dp)
//!   * source decimals 6 (USDC) -> out = in * 1e9 / price (WSOL 9dp)
//!
//! Route data: the mock receives the raw borsh payload (route_plan vec
//!           + in_amount + quoted_out_amount + slippage_bps +
//!           platform_fee_bps) with the arg list aligned to the real wire
//!           format, and — like the real program and cypher —
//!           requires platform_fee_bps == 0.
//!
//! This program must NEVER be deployed to mainnet and holds no real
//! value. Its keypair is committed under tests/fixtures/ for
//! reproducible localnet tests.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::spl_token;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

declare_id!("DdKcq1Rm82gJGAZuQLR3wBF2VESdp4FvVmkooD5uFbcG");

#[program]
pub mod mock_jupiter {
    use super::*;

    /// Mirrors Jupiter v6 `route` 1:1, INCLUDING the raw wire format:
    /// the CPI payload after the 8-byte discriminator is exactly
    ///   route_plan (borsh Vec) + in_amount (u64) + quoted_out_amount (u64)
    ///   + slippage_bps (u16) + platform_fee_bps (u8),
    /// so these args line up structurally with the raw bytes (anchor
    /// tolerates trailing bytes; variable-length real plans are a
    /// mainnet-only concern — the mock is only used with empty plans).
    pub fn route<'info>(
        ctx: Context<'_, '_, '_, 'info, MockRoute<'info>>,
        _route_plan: Vec<u8>,
        in_amount: u64,
        _quoted_out_amount: u64,
        _slippage_bps: u16,
        platform_fee_bps: u8,
    ) -> Result<()> {
        // Anti-fee-extraction, same as cypher's own on-chain check.
        require!(platform_fee_bps == 0, MockError::BadRouteData);

        // remaining_accounts layout supplied by tests:
        //   [0] = mock price state PDA (raw borsh {authority, price})
        //   [1] = source mint account (needed for burn)
        require!(ctx.remaining_accounts.len() >= 2, MockError::MissingPriceState);
        let price_state = &ctx.remaining_accounts[0];
        let source_mint = &ctx.remaining_accounts[1];

        let data = price_state
            .try_borrow_data()
            .map_err(|_| error!(MockError::MissingPriceState))?;
        require!(data.len() >= 8 + 32 + 8, MockError::MissingPriceState);
        let price = u64::from_le_bytes(
            data[8 + 32..8 + 32 + 8]
                .try_into()
                .map_err(|_| error!(MockError::MissingPriceState))?,
        );
        require!(price > 0, MockError::BadPrice);
        drop(data);

        let src = &ctx.accounts.user_source_token_account;
        let dst = &ctx.accounts.user_destination_token_account;

        // Like the real Jupiter: consume EXACTLY in_amount from the source
        // (never the whole balance — cypher enforces exact input on-chain).
        let amount_in = in_amount;
        require!(
            amount_in > 0 && amount_in <= src.amount,
            MockError::ZeroInput
        );

        // Sanity: the source mint account must match the token account's
        // mint (protects the mock from being invoked nonsensically).
        require!(
            source_mint.key() == src.mint,
            MockError::SameMint
        );
        require!(
            source_mint.key() != ctx.accounts.destination_mint.key(),
            MockError::SameMint
        );

        // Read the source mint's decimals to pick the swap direction.
        let mint_data = source_mint
            .try_borrow_data()
            .map_err(|_| error!(MockError::SameMint))?;
        let source_mint_state = spl_token::state::Mint::unpack(&mint_data)
            .map_err(|_| error!(MockError::SameMint))?;
        drop(mint_data);

        let out: u64 = if source_mint_state.decimals == 9 {
            // WSOL -> USDC: out = in * price / 1e9
            ((amount_in as u128) * (price as u128) / 1_000_000_000u128) as u64
        } else {
            // USDC -> WSOL: out = in * 1e9 / price
            ((amount_in as u128) * 1_000_000_000u128 / (price as u128)) as u64
        };
        require!(out > 0, MockError::ZeroOutput);

        // 1. Burn the input tokens (authority = position PDA, signed by
        //    the outer CPI from cypher — same trust shape as real).
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: source_mint.to_account_info(),
                    from: src.to_account_info(),
                    authority: ctx.accounts.user_transfer_authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // 2. Mint the "fill" output into the destination account using
        //    the mock's PDA mint authority (tests set mint authorities).
        let mint_auth_seeds: &[&[u8]] =
            &[b"mock_mint_auth", &[ctx.bumps.mint_authority]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::MintTo {
                    mint: ctx.accounts.destination_mint.to_account_info(),
                    to: dst.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[mint_auth_seeds],
            ),
            out,
        )?;

        Ok(())
    }

    /// Test helper: create/overwrite the mock price state PDA.
    pub fn set_price(ctx: Context<SetPrice>, price: u64) -> Result<()> {
        require!(price > 0, MockError::BadPrice);
        let s = &mut ctx.accounts.price_state;
        s.authority = ctx.accounts.authority.key();
        s.price = price;
        Ok(())
    }

    /// Test helper: write a VALID Pyth `PriceUpdateV2` account layout
    /// (discriminator + borsh, identical to pyth-solana-receiver-sdk
    /// v2.0.0) into the ["pyth"] PDA. cypher parses this account with
    /// its own on-chain parser, so tests exercise the real parsing path.
    /// `age_secs` backdates publish_time (staleness tests).
    pub fn set_pyth_price(
        ctx: Context<SetPythPrice>,
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        exponent: i32,
        age_secs: i64,
    ) -> Result<()> {
        require!(price > 0, MockError::BadPrice);
        let clock = Clock::get()?;
        let publish_time = clock.unix_timestamp - age_secs;
        let mut d = Vec::with_capacity(8 + 32 + 1 + 84 + 8);
        // genuine PriceUpdateV2 anchor discriminator:
        // sha256("account:PriceUpdateV2")[..8] (matches cypher's parser)
        d.extend_from_slice(&[0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);
        d.extend_from_slice(&[0u8; 32]); // write_authority
        d.push(1u8); // verification_level = Full
        d.extend_from_slice(&feed_id);
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&conf.to_le_bytes());
        d.extend_from_slice(&exponent.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes()); // prev_publish_time
        d.extend_from_slice(&price.to_le_bytes()); // ema_price
        d.extend_from_slice(&conf.to_le_bytes()); // ema_conf
        d.extend_from_slice(&clock.slot.to_le_bytes()); // posted_slot
        let mut data = ctx
            .accounts
            .pyth_account
            .try_borrow_mut_data()
            .map_err(|_| error!(MockError::Overflow))?;
        require!(data.len() >= d.len(), MockError::Overflow);
        data[..d.len()].copy_from_slice(&d);
        Ok(())
    }
}

#[error_code]
pub enum MockError {
    #[msg("mock price state account missing")]
    MissingPriceState,
    #[msg("mock price must be positive")]
    BadPrice,
    #[msg("mock swap input is zero")]
    ZeroInput,
    #[msg("mock swap output is zero")]
    ZeroOutput,
    #[msg("malformed route data payload")]
    BadRouteData,
    #[msg("source mint mismatch")]
    SameMint,
    #[msg("overflow in mock price math")]
    Overflow,
}

/// Price state PDA data (["price"] under the mock program).
#[account]
pub struct MockPriceState {
    pub authority: Pubkey,
    /// USDC (6dp) per SOL — the mock's fixed fill price.
    pub price: u64,
}

impl MockPriceState {
    pub const SPACE: usize = 8 + 32 + 8;
}

#[derive(Accounts)]
pub struct MockRoute<'info> {
    pub token_program: Program<'info, Token>,
    /// CHECK: caller's transfer authority (position PDA, signed via the
    /// outer CPI from cypher).
    pub user_transfer_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_source_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub user_destination_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: v6 route destinationTokenAccount slot (pass-through; the
    /// real Jupiter uses a dummy here for plain token-to-token swaps).
    #[account(mut)]
    pub destination_token_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub destination_mint: Box<Account<'info, Mint>>,
    /// CHECK: v6 route platformFeeAccount slot (pass-through; route data
    /// must carry platform_fee_bps == 0, enforced above).
    #[account(mut)]
    pub platform_fee_account: UncheckedAccount<'info>,
    /// CHECK: event authority (order-compatible dummy in the mock; not used).
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: program self-account (order-compatible dummy; not used).
    pub program: UncheckedAccount<'info>,
    /// CHECK: mock's own mint authority PDA (seeds constrained) — mints the output "fill".
    #[account(seeds = [b"mock_mint_auth"], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    // remaining_accounts[0] = MockPriceState PDA
    // remaining_accounts[1] = source mint account
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(init_if_needed, payer = authority, space = MockPriceState::SPACE, seeds = [b"price"], bump)]
    pub price_state: Account<'info, MockPriceState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPythPrice<'info> {
    /// CHECK: raw-written PriceUpdateV2 layout; PDA of this program.
    #[account(init_if_needed, payer = authority, space = 140, seeds = [b"pyth"], bump)]
    pub pyth_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}
