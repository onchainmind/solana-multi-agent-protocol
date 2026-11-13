# libFuzzer & Property-Based Fuzzing for Cypher Smart Contract

This directory contains coverage-guided LLVM libFuzzer harnesses for the **Cypher** smart contract, targeting the fixed-point math engine and external Pyth oracle parsing logic.

---

## 1. Fuzzing Targets

### A. `fuzz_math` (`fuzz_targets/fuzz_math.rs`)
- **Scope**: `cypher::math::sol_to_usdc`, `cypher::math::usdc_to_sol`, `cypher::math::apply_slippage_down`.
- **Invariants Verified**:
  - Zero panics or arithmetic overflows for arbitrary `u128` amounts, prices, and slippage inputs.
  - Roundtrip conversions between SOL and USDC remain accurate within a maximum bound of 2 units of truncation.
  - Slippage calculations are strictly monotonic and mathematically bounded by the initial deposit.

### B. `fuzz_parse_price_update` (`fuzz_targets/fuzz_parse_price_update.rs`)
- **Scope**: `cypher::oracle::parse_price_update_bytes`.
- **Invariants Verified**:
  - The Pyth `PriceUpdateV2` deserializer must only return `Ok(PriceFeed)` or `Err(ProgramError)`.
  - It must **never panic, wrap, or cause out-of-bounds memory access** on arbitrary corrupt or adversarial byte sequences.

---

## 2. Running libFuzzer (Nightly Toolchain)

Prerequisites:
```bash
cargo install cargo-fuzz
rustup install nightly
```

Execute fuzzing runs:
```bash
cd agent-cipher/fuzz

# Fuzz fixed-point arithmetic invariants (10 minutes)
cargo +nightly fuzz run fuzz_math -- -max_total_time=600

# Fuzz Pyth oracle byte parser (10 minutes)
cargo +nightly fuzz run fuzz_parse_price_update -- -max_total_time=600
```

---

## 3. Fast In-Suite Fuzz Tests (Stable Rust)

For CI pipelines and developers on stable Rust, the exact same invariants are exercised deterministically via `proptest` within the unit test suite:

```bash
cd agent-cipher
cargo test -p cypher --lib
```

