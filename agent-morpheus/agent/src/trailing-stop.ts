/**
 * Agent Morpheus — Dynamic Trailing Stop-Loss & High-Water Mark Guard
 *
 * Sharpness Feature:
 * Tracks the high-water mark (peak price) during active holding cycles and
 * dynamically ratchets the stop-loss price upward to lock in unrealized profits.
 *
 * Invariant:
 * - Trailing stop price is monotonically non-decreasing during an active cycle.
 * - When current price breaches `peakPrice * (1 - trailingStopBps / 10000)`,
 *   an emergency profit-locking exit is triggered.
 */

export interface TrailingStopState {
  entryPriceUsd: number;
  peakPriceUsd: number;
  trailingStopBps: number;
  isActive: boolean;
}

export function updateHighWaterMark(
  state: TrailingStopState,
  currentPriceUsd: number
): TrailingStopState {
  if (!state.isActive || currentPriceUsd <= 0) {
    return state;
  }
  const newPeak = Math.max(state.peakPriceUsd, currentPriceUsd);
  return {
    ...state,
    peakPriceUsd: newPeak,
  };
}

export function evaluateTrailingStop(
  state: TrailingStopState,
  currentPriceUsd: number
): {
  shouldExit: boolean;
  effectiveStopPrice: number;
  drawdownFromPeakBps: number;
  lockedGainBps: number;
} {
  if (!state.isActive || state.peakPriceUsd <= 0 || currentPriceUsd <= 0) {
    return {
      shouldExit: false,
      effectiveStopPrice: 0,
      drawdownFromPeakBps: 0,
      lockedGainBps: 0,
    };
  }

  // Calculate the trailing threshold: peak * (1 - trailingStopBps / 10000)
  const effectiveStopPrice = state.peakPriceUsd * (1 - state.trailingStopBps / 10_000);

  // Drawdown from peak in bps
  const drawdownFromPeakBps = Math.max(
    0,
    Math.round(((state.peakPriceUsd - currentPriceUsd) / state.peakPriceUsd) * 10_000)
  );

  // Locked gain relative to entry price in bps
  const lockedGainBps = Math.round(
    ((effectiveStopPrice - state.entryPriceUsd) / state.entryPriceUsd) * 10_000
  );

  const shouldExit = currentPriceUsd <= effectiveStopPrice;

  return {
    shouldExit,
    effectiveStopPrice: Number(effectiveStopPrice.toFixed(4)),
    drawdownFromPeakBps,
    lockedGainBps,
  };
}

