//! Checked fixed-point math helpers.
//!
//! Conventions used across the program:
//!
//! * SOL amounts: lamports / WSOL base units (9 decimals).
//! * USDC amounts: base units (6 decimals).
//! * Oracle price: "USDC micro-units per SOL", i.e. a 6-decimal fixed
//!   point number (price 150_000_000 == $150 per SOL).
//!
//! Every operation is overflow-checked and returns `MathOverflow` on
//! failure instead of wrapping (SBF builds have overflow checks enabled
//! in Cargo.toml as defense in depth).

use crate::errors::CypherError;
use anchor_lang::prelude::*;

pub const PRICE_SCALE: u128 = 1_000_000; // 6dp
pub const SOL_SCALE: u128 = 1_000_000_000; // 9dp
pub const BPS_DENOM: u128 = 10_000;

/// `a * b / d` in u128 with overflow and zero-division checks (rounds down).
pub fn mul_div(a: u128, b: u128, d: u128) -> Result<u128> {
    require!(d != 0, CypherError::MathOverflow);
    let prod = a
        .checked_mul(b)
        .ok_or_else(|| error!(CypherError::MathOverflow))?;
    Ok(prod / d)
}

/// `a * bps / 10_000` with checks.
pub fn bp_mul(a: u128, bps: u16) -> Result<u128> {
    mul_div(a, bps as u128, BPS_DENOM)
}

/// Convert a Pyth price (i64 mantissa + i32 exponent) into the program's
/// canonical 6dp USDC-per-SOL representation.
///
/// value = price * 10^exponent (true dollar price).
/// result = price * 10^(exponent + 6).
///
/// Exponents beyond [-30, 30] are rejected outright.
pub fn price_to_6dp(price: i64, exponent: i32) -> Result<u64> {
    require!(
        (-30..=30).contains(&exponent),
        CypherError::PriceTooVolatile
    );
    require!(price > 0, CypherError::PriceTooVolatile);
    let price = price as i128;
    let shift = exponent + 6;
    let v: i128 = if shift >= 0 {
        price
            .checked_mul(10i128.checked_pow(shift as u32).ok_or_else(|| error!(CypherError::MathOverflow))?)
            .ok_or_else(|| error!(CypherError::MathOverflow))?
    } else {
        price
            .checked_div(10i128.checked_pow((-shift) as u32).ok_or_else(|| error!(CypherError::MathOverflow))?)
            .ok_or_else(|| error!(CypherError::MathOverflow))?
    };
    require!(v > 0 && v <= u64::MAX as i128, CypherError::PriceTooVolatile);
    Ok(v as u64)
}

/// Convert a conf value the same way (used for the confidence bound check).
pub fn conf_to_6dp(conf: u64, exponent: i32) -> Result<u128> {
    require!(
        (-30..=30).contains(&exponent),
        CypherError::PriceTooVolatile
    );
    let conf = conf as i128;
    let shift = exponent + 6;
    let v: i128 = if shift >= 0 {
        conf.checked_mul(10i128.checked_pow(shift as u32).ok_or_else(|| error!(CypherError::MathOverflow))?)
            .ok_or_else(|| error!(CypherError::MathOverflow))?
    } else {
        conf.checked_div(10i128.checked_pow((-shift) as u32).ok_or_else(|| error!(CypherError::MathOverflow))?)
            .ok_or_else(|| error!(CypherError::MathOverflow))?
    };
    require!(v >= 0, CypherError::PriceTooVolatile);
    Ok(v as u128)
}

/// Expected WSOL output (9dp) for a USDC input (6dp) at `price` (6dp):
/// `usdc_in * SOL_SCALE / price`.
pub fn usdc_to_sol(usdc_in: u64, price: u64) -> Result<u128> {
    require!(price != 0, CypherError::PriceTooVolatile);
    mul_div(usdc_in as u128, SOL_SCALE, price as u128)
}

/// Expected USDC output (6dp) for a WSOL input (9dp) at `price` (6dp):
/// `sol_in * price / SOL_SCALE`.
pub fn sol_to_usdc(sol_in: u64, price: u64) -> Result<u128> {
    mul_div(sol_in as u128, price as u128, SOL_SCALE)
}

/// Apply a slippage bound: `amount * (10_000 - slippage_bps) / 10_000`.
pub fn apply_slippage_down(amount: u128, slippage_bps: u16) -> Result<u128> {
    require!(
        slippage_bps < BPS_DENOM as u16,
        CypherError::InvalidParams
    );
    let factor = BPS_DENOM - slippage_bps as u128;
    mul_div(amount, factor, BPS_DENOM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_conversion_roundtrip() {
        // Pyth SOL/USD on mainnet uses exponent -9: 149_123_456_789 => $149.123456789
        let p = price_to_6dp(149_123_456_789, -9).unwrap();
        assert_eq!(p, 149_123_456); // 6dp => $149.123456
    }

    #[test]
    fn usdc_sol_conversion() {
        // $15 at $150/SOL = 0.1 SOL
        let sol = usdc_to_sol(15_000_000, 150_000_000).unwrap();
        assert_eq!(sol, 100_000_000);
        // back
        let usdc = sol_to_usdc(100_000_000, 150_000_000).unwrap();
        assert_eq!(usdc, 15_000_000);
    }

    #[test]
    fn slippage_bound() {
        let min = apply_slippage_down(15_000_000, 50).unwrap(); // 0.5%
        assert_eq!(min, 14_925_000);
    }

    #[test]
    fn overflow_rejected() {
        assert!(mul_div(u128::MAX, 2, 3).is_err());
        assert!(price_to_6dp(-5, -9).is_err());
    }

    // -----------------------------------------------------------------
    // Property tests (deterministic pseudo-random; run in every CI).
    // -----------------------------------------------------------------

    /// xorshift64* — deterministic, dependency-free RNG (mirrors oracle.rs).
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
    }

    #[test]
    fn property_price_conversion_matches_reference() {
        let mut rng = XorShift(0x0A11_CE20_2600_0101);
        for _ in 0..50_000 {
            let price = (rng.next() % (i64::MAX as u64)) as i64;
            let exp = (rng.next() % 61) as i32 - 30;
            let got = price_to_6dp(price, exp).ok();
            // reference computation in i128 (None == "must be rejected")
            let shift = exp + 6;
            let want: Option<u64> = if price <= 0 {
                None
            } else if shift >= 0 {
                (price as i128)
                    .checked_mul(10i128.pow(shift as u32))
                    .filter(|v| *v > 0 && *v <= u64::MAX as i128)
                    .map(|v| v as u64)
            } else {
                (price as i128)
                    .checked_div(10i128.pow((-shift) as u32))
                    .filter(|v| *v > 0)
                    .map(|v| v as u64)
            };
            assert_eq!(got, want, "price={price} exp={exp}");
        }
    }

    #[test]
    fn property_slippage_is_monotone_and_bounded() {
        let mut rng = XorShift(0x0A11_CE20_2600_0202);
        for _ in 0..20_000 {
            let amount: u128 = (rng.next() % (1 << 60)) as u128;
            let slippage = (rng.next() % 10_000) as u16;
            let got = apply_slippage_down(amount, slippage);
            if slippage >= 10_000 {
                assert!(got.is_err());
                continue;
            }
            let out = got.unwrap();
            assert!(out <= amount, "slippage output must never exceed input");
            // exact reference
            let expect = amount * (10_000 - slippage as u128) / 10_000;
            assert_eq!(out, expect);
            // monotonicity: more slippage -> smaller or equal output
            if slippage + 1 < 10_000 {
                let out2 = apply_slippage_down(amount, slippage + 1).unwrap();
                assert!(out2 <= out);
            }
        }
    }

    #[test]
    fn property_conversions_roundtrip_within_truncation() {
        let mut rng = XorShift(0x0A11_CE20_2600_0303);
        for _ in 0..20_000 {
            let price = 1 + rng.next() % 1_000_000_000; // $0.000000001 .. $1e9 (6dp)
            let sol: u128 = (rng.next() % (1 << 54)) as u128; // up to ~2^54 lamports
            let usdc = sol_to_usdc(sol as u64, price).unwrap();
            // back-conversion must recover the original within two units of
            // truncation on each side.
            let sol2 = usdc_to_sol(usdc as u64, price).unwrap();
            // Exact bound: the sol->usdc floor loses < 1 usdc (= SOL_SCALE /
            // price lamports); the usdc->sol floor loses < 1 lamport.
            let tol = (1_000_000_000u128 / price as u128 + 1) as i128;
            assert!(
                (sol as i128 - sol2 as i128).abs() <= tol,
                "roundtrip drift too large: sol={sol} usdc={usdc} back={sol2} tol={tol}"
            );
        }
    }
}
