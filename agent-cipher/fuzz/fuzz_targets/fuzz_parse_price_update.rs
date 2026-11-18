//! Coverage-guided fuzz target: the PriceUpdateV2 parser may only return
//! Ok or Err — it must never panic on arbitrary bytes.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = cypher::oracle::parse_price_update_bytes(data);
});
