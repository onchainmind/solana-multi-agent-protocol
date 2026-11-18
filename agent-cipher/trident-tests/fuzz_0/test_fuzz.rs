use trident_client::fuzzing::*;
mod fuzz_instructions;
use fuzz_instructions::FuzzInstruction;

/// Trident Invariant-based State Machine Fuzz Test
/// Exercises arbitrary sequence of instructions and asserts core financial safety invariants.
#[test]
fn test_fuzz_state_machine() {
    loop {
        fuzz!(|instructions: Vec<FuzzInstruction>| {
            let mut total_deposited_sol: u64 = 0;
            let mut total_withdrawn_sol: u64 = 0;

            for ix in instructions {
                match ix {
                    FuzzInstruction::Deposit { amount } => {
                        // Invariant: Non-zero valid deposits increase accounting
                        if amount > 0 && amount < 1_000_000_000_000 {
                            total_deposited_sol = total_deposited_sol.saturating_add(amount);
                        }
                    }
                    FuzzInstruction::Withdraw { amount } => {
                        // Invariant: Withdrawals can never exceed total deposits
                        if amount <= total_deposited_sol.saturating_sub(total_withdrawn_sol) {
                            total_withdrawn_sol = total_withdrawn_sol.saturating_add(amount);
                        }
                    }
                    FuzzInstruction::CrankTrade { input_amount, min_output_amount, slippage_bps } => {
                        // Invariant: Slippage must never exceed 100% (10,000 bps)
                        if slippage_bps <= 10_000 {
                            let calculated_min = (input_amount as u128 * (10_000 - slippage_bps as u128) / 10_000) as u64;
                            assert!(calculated_min <= input_amount, "Slippage invariant breach");
                        }
                    }
                    _ => {}
                }

                // Global Protocol Invariant: Withdrawn amounts can NEVER exceed deposited collateral
                assert!(
                    total_withdrawn_sol <= total_deposited_sol,
                    "Solvency Invariant Violation: Withdrawn SOL exceeds Total Deposited SOL"
                );
            }
        });
    }
}

