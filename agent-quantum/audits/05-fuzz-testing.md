# Audit Report: Fuzz Testing & Mathematical Property Verification

## 1. Overview
The Cypher codebase incorporates two tiers of fuzz testing and property verification:
1. **In-Suite Deterministic Property Testing**: Executed on every CI run via fast PRNG generators (`XorShift(64)`).
2. **Coverage-Guided libFuzzer Harnesses**: Located in `fuzz/` for deep auditor fuzzing.

---

## 2. In-Suite Property Testing Review

### A. Price Conversion Monotonicity & Reference Match (`math.rs`)
- **Property**: `price_to_6dp(price, exponent)` must exactly match an arbitrary-precision reference implementation in `i128` across 50,000 randomized inputs without overflowing or panicking.
- **Bounds**: Exponents outside `[-30, 30]` and negative prices are deterministically rejected.
- **Result**: PASSED (50,000 iterations).

### B. Slippage Calculation Invariant (`apply_slippage_down`)
- **Invariants Verified**:
  - `apply_slippage_down(amount, slippage) <= amount` for all `amount` and `slippage`.
  - Monotonicity: `apply_slippage_down(amount, s + 1) <= apply_slippage_down(amount, s)`.
  - Exact reference alignment: `amount * (10_000 - slippage) / 10_000`.
- **Result**: PASSED (20,000 iterations).

### C. Unit-Roundtrip Truncation Invariant
- **Invariant**: Converting `SOL -> USDC` and back to `USDC -> SOL` loses strictly less than the theoretical mathematical truncation error (`(1e9 / price + 1)` lamports).
- **Result**: PASSED (20,000 iterations).

---

## 3. Byte Parser Fuzzing (`oracle.rs`)
- **Target**: `parse_price_update_bytes(data: &[u8])`
- **Fuzzing Objective**: Prove that no slice of arbitrary bytes can trigger a Rust panic, slice out-of-bounds error, or integer underflow.
- **Historical Finding**: An earlier version had a panic vulnerability when handling truncated `verification_level = Partial` variants (variant 0 carries an extra `num_signatures` byte). The parser was patched to enforce variant-aware bounds check (`8 + 32 + ver_len + 84 + 8`), and regression tests prove safety.

---

## 4. libFuzzer Harnesses in `fuzz/`
Auditors can run continuous coverage-guided fuzzing with:
```bash
cargo install cargo-fuzz
cargo +nightly fuzz run fuzz_parse_price_update -- -max_total_time=600
cargo +nightly fuzz run fuzz_math -- -max_total_time=600
```
- Targets tested: `fuzz_math.rs` and `fuzz_parse_price_update.rs`.
- Status: Clean (zero crashes or hangs reported).
