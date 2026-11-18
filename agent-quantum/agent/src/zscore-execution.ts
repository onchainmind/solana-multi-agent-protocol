/**
 * Quantum Engine: Statistical Mean-Reversion Execution State Machine
 * Manages position entry, dynamic stop-loss, and mean-reversion take-profit
 */

export class ZScoreExecutionManager {
  /**
   * Determine trade lifecycle action based on active position and current Z-score
   */
  public static checkLifecycle(
    currentZScore: number,
    positionSide: 'LONG_SPREAD' | 'SHORT_SPREAD' | 'FLAT',
    takeProfitZScore: number = 0.25,
    stopLossZScore: number = 3.5
  ): { action: 'TAKE_PROFIT' | 'STOP_LOSS' | 'HOLD_POSITION' | 'NO_POSITION'; reason: string } {
    if (positionSide === 'FLAT') {
      return { action: 'NO_POSITION', reason: 'No active pair spread position.' };
    }

    if (positionSide === 'LONG_SPREAD') {
      // Entered when Z <= -2.0. Take profit when Z reverts back near 0
      if (currentZScore >= -takeProfitZScore) {
        return { action: 'TAKE_PROFIT', reason: `Mean reversion achieved: Z-score reached ${currentZScore}.` };
      }
      // Stop loss if spread diverges beyond -3.5
      if (currentZScore <= -stopLossZScore) {
        return { action: 'STOP_LOSS', reason: `Divergence breakdown: Z-score exceeded stop threshold ${currentZScore}.` };
      }
    } else if (positionSide === 'SHORT_SPREAD') {
      // Entered when Z >= +2.0. Take profit when Z reverts back near 0
      if (currentZScore <= takeProfitZScore) {
        return { action: 'TAKE_PROFIT', reason: `Mean reversion achieved: Z-score reached ${currentZScore}.` };
      }
      // Stop loss if spread diverges beyond +3.5
      if (currentZScore >= stopLossZScore) {
        return { action: 'STOP_LOSS', reason: `Divergence breakdown: Z-score exceeded stop threshold ${currentZScore}.` };
      }
    }

    return { action: 'HOLD_POSITION', reason: `Spread within expected oscillation range (Z=${currentZScore}).` };
  }
}
