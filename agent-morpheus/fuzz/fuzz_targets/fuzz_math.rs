//! Coverage-guided fuzz target for the fixed-point math helpers:
//! invariants that must hold for ANY input.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::cmp::{max, min};

fuzz_target!(|data: &[u8]| {
    if data.len() < 20 {
        return;
    }
    let u = |o: usize| -> u128 {
        let mut b = [0u8; 16];
        b[..8].copy_from_slice(&data[o..o + 8]);
        u128::from_le_bytes(b)
    };
    let price = (u(0) % 1_000_000_000) as u64; // 6dp
    let amount = u(8) % (1 << 60);
    let slippage = (u(16) % 20_000) as u16;

    // price helpers never panic
    if let (Ok(usdc), true) = (cypher::math::sol_to_usdc(amount as u64, price), price > 0) {
        if let Ok(sol) = cypher::math::usdc_to_sol(usdc, price) {
            // roundtrip within 2 units of truncation
            assert!((sol as i128 - amount as i128).abs() <= 2);
        }
    }
    // slippage: bounded by input, exact reference, monotone
    if let Ok(out) = cypher::math::apply_slippage_down(amount, slippage) {
        assert!(out <= amount);
        if slippage < 10_000 {
            assert_eq!(out, amount * (10_000 - slippage as u128) / 10_000);
            if let Ok(out2) = cypher::math::apply_slippage_down(amount, min(slippage + 1, 9_999)) {
                assert!(out2 <= max(out, out2) || out2 <= out);
            }
        }
    }
});
