//! Pyth oracle reading with strict validation.
//!
//! SINGLE-FEED DESIGN: this program prices exactly one market — Pyth
//! SOL/USD — and nothing else. The feed id is pinned in `GlobalConfig`
//! at initialize and every oracle read is validated against it.
//!
//! Mainnet trust model (verified against live mainnet, 2026-11 — see
//! docs/MAINNET_VERIFICATION.md):
//!
//! * Pyth's classic push-oracle accounts are decommissioned (years
//!   stale). The live format is the **pull oracle**: a `PriceUpdateV2`
//!   account written by the **Pyth Solana Receiver program** after it
//!   verifies a Wormhole VAA signed by Pyth's guardians.
//! * Receiver accounts have NO canonical address — aggregators post
//!   fresh ones continuously (~4k live SOL/USD accounts at any time).
//!   The trust anchor is therefore **ownership**: only the receiver
//!   program can create/write accounts it owns, and it only writes
//!   verified Pyth messages.
//!
//! The program thus accepts an oracle account only when ALL of these
//! hold (enforced here, in one auditable place):
//!
//! 1. `account.owner == config.pyth_receiver_program` (config-pinned,
//!    timelock-protected; mainnet value rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ),
//! 2. the first 8 bytes are the genuine Anchor discriminator for
//!    `account:PriceUpdateV2` = sha256("account:PriceUpdateV2")[..8],
//! 3. the borsh payload parses as (layout per pyth-solana-receiver-sdk
//!    v2.0.0):
//!
//!    ```text
//!    write_authority:        Pubkey (32)
//!    verification_level:     enum  { Partial{num_signatures: u8} = 0, Full = 1 }
//!    price_message:
//!        feed_id:            [u8; 32]
//!        price:              i64
//!        conf:               u64
//!        exponent:           i32
//!        publish_time:       i64
//!        prev_publish_time:  i64
//!        ema_price:          i64
//!        ema_conf:           u64
//!    posted_slot:            u64
//!    ```
//! 4. the embedded `feed_id` equals the configured SOL/USD feed id,
//! 5. `publish_time` is inside `[now − staleness, now + 60s]`,
//! 6. the confidence interval is narrower than
//!    `config.max_price_conf_bps` of the price itself.
//!
//! Price is normalized to a 6dp USDC-per-SOL fixed point number (see
//! `math::price_to_6dp`).

use crate::errors::CypherError;
use crate::math::{conf_to_6dp, price_to_6dp};
use crate::state::GlobalConfig;
use anchor_lang::prelude::*;

/// Maximum tolerated future publish_time skew (seconds).
pub const MAX_FUTURE_SKEW_SECS: i64 = 60;

/// Anchor discriminator of the `PriceUpdateV2` account type:
/// sha256("account:PriceUpdateV2")[..8].
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

/// Verified price data extracted from a `PriceUpdateV2` account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PriceUpdateV2 {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub posted_slot: u64,
}

/// Byte-level parser: 8-byte anchor discriminator + borsh payload.
/// Pure function over the account bytes (unit-testable, fuzzed).
pub fn parse_price_update_bytes(data: &[u8]) -> Result<PriceUpdateV2> {
    // Minimum HEADER size: 8 disc + 32 authority + 1 verification tag.
    // (The verification variant decides the total length — checked below.)
    if data.len() < 8 + 32 + 1 {
        return err!(CypherError::OracleAccountInvalid);
    }

    require!(
        data[0..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        CypherError::OracleAccountInvalid
    );

    let mut o = 8usize;

    // write_authority (skipped, unused)
    o += 32;

    // verification_level: borsh enum variant u8; variant 0 (Partial) carries
    // an extra u8 payload, variant 1 (Full) carries nothing.
    let variant = data[o];
    require!(variant <= 1, CypherError::OracleAccountInvalid);
    let ver_len = 1 + if variant == 0 { 1 } else { 0 };
    // Total minimum: header + verification payload + 84-byte message + slot.
    // Variant-aware: a truncated Partial account must be REJECTED, not sliced.
    if data.len() < 8 + 32 + ver_len + 84 + 8 {
        return err!(CypherError::OracleAccountInvalid);
    }
    o += ver_len;

    // price_message
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&data[o..o + 32]);
    o += 32;
    let rd_i64 = |d: &[u8], off: usize| -> i64 {
        i64::from_le_bytes(d[off..off + 8].try_into().expect("fixed-size slice"))
    };
    let rd_u64 = |d: &[u8], off: usize| -> u64 {
        u64::from_le_bytes(d[off..off + 8].try_into().expect("fixed-size slice"))
    };
    let price = rd_i64(data, o);
    o += 8;
    let conf = rd_u64(data, o);
    o += 8;
    let exponent = i32::from_le_bytes(data[o..o + 4].try_into().expect("fixed-size slice"));
    o += 4;
    let publish_time = rd_i64(data, o);
    o += 8;
    o += 8; // prev_publish_time (unused)
    o += 8; // ema_price (unused)
    o += 8; // ema_conf (unused)

    let posted_slot = rd_u64(data, o);

    Ok(PriceUpdateV2 {
        feed_id,
        price,
        conf,
        exponent,
        publish_time,
        posted_slot,
    })
}

/// Account-level gate + parser. The account is accepted ONLY if
///
/// * its owner is the configured Pyth receiver program, and
/// * it parses as a genuine `PriceUpdateV2` (discriminator + borsh).
///
/// This is the oracle's entire trust anchor; everything after this
/// (feed id, freshness, confidence) is validated in [`read_sol_price`].
pub fn parse_price_update(
    ai: &UncheckedAccount,
    receiver_program: &Pubkey,
) -> Result<PriceUpdateV2> {
    require!(
        ai.owner == receiver_program,
        CypherError::OracleNotReceiverOwned
    );
    let data = ai
        .try_borrow_data()
        .map_err(|_| error!(CypherError::OracleAccountInvalid))?;
    parse_price_update_bytes(&data)
}

/// Read + validate the SOL/USD price from a parsed Pyth price update.
///
/// Returns the canonical 6dp USDC-per-SOL price.
pub fn read_sol_price(
    price_update: &PriceUpdateV2,
    clock: &Clock,
    config: &GlobalConfig,
) -> Result<u64> {
    require!(
        price_update.feed_id == config.sol_usd_feed_id,
        CypherError::WrongFeedId
    );

    // Reject absurd future timestamps (publish clock skew).
    require!(
        price_update.publish_time <= clock.unix_timestamp + MAX_FUTURE_SKEW_SECS,
        CypherError::FuturePrice
    );

    // Reject stale prices.
    require!(
        clock.unix_timestamp - price_update.publish_time
            <= config.max_price_staleness_secs,
        CypherError::StaleOraclePrice
    );

    // Confidence-interval bound: conf <= price * conf_bps / 10_000.
    let price_6dp = price_to_6dp(price_update.price, price_update.exponent)?;
    let conf_6dp = conf_to_6dp(price_update.conf, price_update.exponent)?;
    let conf_limit = (price_6dp as u128)
        .checked_mul(config.max_price_conf_bps as u128)
        .ok_or_else(|| error!(CypherError::MathOverflow))?
        / 10_000;
    require!(conf_6dp <= conf_limit, CypherError::PriceTooVolatile);

    Ok(price_6dp)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a serialized PriceUpdateV2 account (discriminator + borsh),
    /// mirroring what the Pyth receiver program writes.
    fn build_account(
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        exponent: i32,
        publish_time: i64,
    ) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
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
        d.extend_from_slice(&42u64.to_le_bytes()); // posted_slot
        d
    }

    #[test]
    fn parses_full_layout() {
        let mut feed = [0u8; 32];
        feed[0] = 0xef;
        feed[31] = 0x5d;
        let acc = build_account(feed, 149_123_456_789, 50_000_000, -9, 1_700_000_000);
        assert_eq!(acc.len(), 8 + 32 + 1 + 84 + 8);

        let p = parse_price_update_bytes(&acc).unwrap();
        assert_eq!(p.feed_id, feed);
        assert_eq!(p.price, 149_123_456_789);
        assert_eq!(p.conf, 50_000_000);
        assert_eq!(p.exponent, -9);
        assert_eq!(p.publish_time, 1_700_000_000);
        assert_eq!(p.posted_slot, 42);
    }

    #[test]
    fn parses_partial_verification_level() {
        let mut acc = build_account([7u8; 32], 100, 1, -6, 5);
        // flip verification level to Partial{num_signatures: 3}
        acc[8 + 32] = 0u8; // variant 0
        acc.insert(8 + 32 + 1, 3u8); // num_signatures payload
        let p = parse_price_update_bytes(&acc).unwrap();
        assert_eq!(p.price, 100);
        assert_eq!(p.exponent, -6);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_price_update_bytes(&[0u8; 10]).is_err());
    }

    #[test]
    fn rejects_wrong_discriminator() {
        let mut acc = build_account([7u8; 32], 100, 1, -6, 5);
        acc[0] = 0x00; // break the anchor discriminator
        assert!(parse_price_update_bytes(&acc).is_err());
    }

    #[test]
    fn rejects_unknown_verification_variant() {
        let mut acc = build_account([7u8; 32], 100, 1, -6, 5);
        acc[8 + 32] = 7u8; // neither Partial(0) nor Full(1)
        assert!(parse_price_update_bytes(&acc).is_err());
    }

    #[test]
    fn mainnet_discriminator_matches_pyth_layout() {
        // Cross-checked on live mainnet (docs/MAINNET_VERIFICATION.md):
        // 11 309 PriceUpdateV2 accounts carry this discriminator prefix.
        let mut h = [0u8; 8];
        // sha256("account:PriceUpdateV2")[..8] — hard-assert the constant
        // so an accidental edit of the layout is caught here.
        h.copy_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        assert_eq!(h, [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);
    }

    // -----------------------------------------------------------------
    // In-suite fuzzing: deterministic pseudo-random inputs must never
    // panic the parser (it may only return Ok or Err). Runs on every
    // `cargo test` and in CI; a deeper libFuzzer harness lives in fuzz/.
    // -----------------------------------------------------------------

    /// xorshift64* — deterministic, dependency-free RNG.
    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn byte(&mut self) -> u8 {
            (self.next() >> 33) as u8
        }
        fn fill(&mut self, buf: &mut [u8]) {
            for b in buf.iter_mut() {
                *b = self.byte();
            }
        }
    }

    #[test]
    fn fuzz_parser_never_panics_random_bytes() {
        let mut rng = XorShift(0x5EED_2026_1111_0001);
        for len in [0usize, 1, 8, 40, 80, 120, 132, 133, 134, 135, 200, 1024] {
            for _case in 0..2_000 {
                let mut buf = vec![0u8; len];
                rng.fill(&mut buf);
                // Ok or Err both fine — a panic fails the test.
                let _ = parse_price_update_bytes(&buf);
            }
        }
    }

    #[test]
    fn fuzz_parser_never_panics_mutated_valid_accounts() {
        let mut rng = XorShift(0x5EED_2026_2222_0002);
        let base = build_account([0xefu8; 32], 84_000_000_000, 2_000_000, -8, 1_700_000_000);
        for _case in 0..50_000 {
            let mut buf = base.clone();
            // flip 1..=6 random bits anywhere in the account
            let flips = 1 + (rng.next() % 6) as usize;
            for _ in 0..flips {
                let idx = (rng.next() as usize) % buf.len();
                buf[idx] ^= 1u8 << (rng.next() % 8);
            }
            let _ = parse_price_update_bytes(&buf);
        }
    }

    #[test]
    fn property_every_valid_layout_parses_for_any_field_values() {
        // For a well-formed envelope, ANY field values must parse (the
        // parser is layout-only; semantic checks live in read_sol_price).
        let mut rng = XorShift(0x5EED_2026_3333_0003);
        for _case in 0..10_000 {
            let price = rng.next() as i64;
            let conf = rng.next();
            let exp = (rng.next() % 65) as i32 - 32;
            let ts = rng.next() as i64;
            let mut feed = [0u8; 32];
            rng.fill(&mut feed);
            let acc = build_account(feed, price, conf, exp, ts);
            let p = parse_price_update_bytes(&acc).expect("valid envelope must parse");
            assert_eq!(p.feed_id, feed);
            assert_eq!(p.price, price);
            assert_eq!(p.conf, conf);
            assert_eq!(p.exponent, exp);
            assert_eq!(p.publish_time, ts);
        }
    }
}
