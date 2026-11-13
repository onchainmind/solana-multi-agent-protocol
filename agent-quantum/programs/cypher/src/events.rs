//! Program events. Everything a client / indexer / auditor needs to
//! reconstruct state transitions is emitted here.

use crate::state::StrategyKind;
use anchor_lang::prelude::*;

#[event]
pub struct ProtocolInitialized {
    pub admin: Pubkey,
    pub marinade_state: Pubkey,
    pub swap_program: Pubkey,
}

#[event]
pub struct ConfigChangeProposed {
    pub nonce: u64,
    pub execute_at: i64,
}

#[event]
pub struct ConfigChangeExecuted {
    pub nonce: u64,
}

#[event]
pub struct AdminTransferProposed {
    pub current_admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminTransferred {
    pub new_admin: Pubkey,
}

#[event]
pub struct GlobalPaused {
    pub by: Pubkey,
}

#[event]
pub struct GlobalResumed {
    pub by: Pubkey,
}

#[event]
pub struct PositionOpened {
    pub owner: Pubkey,
    pub position: Pubkey,
}

#[event]
pub struct PositionClosed {
    pub owner: Pubkey,
    pub realized_pnl_usdc: i64,
}

#[event]
pub struct DepositedSol {
    pub owner: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct DepositedToken {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct WithdrawnSol {
    pub owner: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct WithdrawnToken {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StrategyStarted {
    pub owner: Pubkey,
    pub strategy: StrategyKind,
}

#[event]
pub struct StrategyStopped {
    pub owner: Pubkey,
}

#[event]
pub struct PositionPaused {
    pub owner: Pubkey,
    pub paused: bool,
}

#[event]
pub struct Staked {
    pub owner: Pubkey,
    pub lamports: u64,
    pub msol_minted: u64,
    pub total_msol: u64,
}

#[event]
pub struct NothingStaked {
    pub owner: Pubkey,
}

#[event]
pub struct Unstaked {
    pub owner: Pubkey,
    pub msol_burned: u64,
}

#[event]
pub struct TradeExecuted {
    pub owner: Pubkey,
    /// true = USDC -> WSOL (DCA buy), false = WSOL -> USDC (exit).
    pub is_buy: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    /// Oracle price (6dp USDC/SOL) at execution.
    pub oracle_price: u64,
    /// New weighted average entry price (6dp) after this trade.
    pub avg_entry_price: u64,
    /// Reason: 0 = DcaEntry, 1 = TakeProfit, 2 = StopLoss, 3 = MaxDrawdown.
    pub reason: u8,
}

#[event]
pub struct Flattened {
    pub owner: Pubkey,
    /// 1 = TakeProfit, 2 = StopLoss, 3 = MaxDrawdown.
    pub reason: u8,
    pub position_paused: bool,
}

#[event]
pub struct NothingToDo {
    pub owner: Pubkey,
}
