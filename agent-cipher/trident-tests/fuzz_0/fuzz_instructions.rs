use trident_client::fuzzing::*;

/// Generated arbitrary instruction fuzz inputs for Cypher Anchor program.
#[derive(Arbitrary, Debug)]
pub enum FuzzInstruction {
    Deposit {
        amount: u64,
    },
    Withdraw {
        amount: u64,
    },
    CrankStake {
        cooldown_seconds: u32,
    },
    CrankTrade {
        input_amount: u64,
        min_output_amount: u64,
        slippage_bps: u16,
    },
    ClosePosition,
}

