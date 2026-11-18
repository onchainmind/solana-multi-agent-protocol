//! Program errors. Every failure mode has a distinct, documented code so
//! auditors and indexers can map failures to causes deterministically.

use anchor_lang::prelude::*;

#[error_code]
pub enum CypherError {
    #[msg("Unauthorized signer for this instruction")]
    Unauthorized,
    #[msg("Protocol is globally paused by admin or guardian")]
    GlobalPaused,
    #[msg("Position is paused (self-pause or drawdown flatten)")]
    PositionPaused,
    #[msg("Strategy is not active; call start_strategy first")]
    StrategyNotActive,
    #[msg("Instruction not valid for the selected strategy kind")]
    InvalidStrategy,
    #[msg("Strategy parameters failed on-chain validation")]
    InvalidParams,
    #[msg("Deposit is below the configured minimum")]
    DepositTooSmall,
    #[msg("Deposit is above the configured maximum")]
    DepositTooLarge,
    #[msg("Withdrawal exceeds the withdrawable balance")]
    InsufficientWithdraw,
    #[msg("Nothing to execute for this crank right now")]
    NothingToDo,
    #[msg("Actual swap output was below the oracle-anchored minimum")]
    SlippageExceeded,
    #[msg("Oracle price is older than the configured staleness limit")]
    StaleOraclePrice,
    #[msg("Oracle price publish_time is unreasonably far in the future")]
    FuturePrice,
    #[msg("Oracle account belongs to a different feed id")]
    WrongFeedId,
    #[msg("Oracle account is not owned by the configured Pyth receiver program")]
    OracleNotReceiverOwned,
    #[msg("Oracle account is not a valid Pyth PriceUpdateV2 (bad discriminator or layout)")]
    OracleAccountInvalid,
    #[msg("Oracle confidence interval is wider than the configured bound")]
    PriceTooVolatile,
    #[msg("Cooldown period has not elapsed since the last action")]
    CooldownActive,
    #[msg("Timelock has not elapsed yet for this change")]
    TimelockNotElapsed,
    #[msg("Timelock entry is invalid, executed or already consumed")]
    TimelockInvalid,
    #[msg("Timelock delay can only be increased, never decreased")]
    TimelockDelayNotIncreasing,
    #[msg("Position still holds funds and cannot be closed")]
    PositionNotEmpty,
    #[msg("On-chain invariant violated: tracked balance != token balance")]
    InvariantBroken,
    #[msg("Swap program accounts failed validation")]
    InvalidSwapAccounts,
    #[msg("Arithmetic overflow while computing")]
    MathOverflow,
    #[msg("Token mint is not accepted for this operation")]
    InvalidMint,
    #[msg("Stake amount is below the configured minimum")]
    StakeTooSmall,
    #[msg("Unstake amount exceeds the currently staked balance")]
    UnstakeTooLarge,
    #[msg("Marinade CPI accounts failed on-chain derivation checks")]
    InvalidMarinadeAccounts,
    #[msg("Swap route data too large")]
    RouteDataTooLarge,
    #[msg("Swap produced no output tokens")]
    EmptySwapOutput,
    #[msg("Strategy is still active; call stop_strategy before closing position")]
    StrategyStillActive,
}
