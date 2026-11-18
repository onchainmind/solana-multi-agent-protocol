/**
 * Oracle Engine: Flash-Loan Manipulation & Spot-TWAP Anomaly Detector
 * Prevents execution when spot prices temporarily diverge from Time-Weighted Average Prices (TWAP)
 */

export class FlashLoanDetector {
  /**
   * Evaluates if a price update exhibits flash-loan manipulation characteristics
   * @param spotPrice Current instantaneous spot price
   * @param twapPrice 30-minute Time-Weighted Average Price
   * @param maxThresholdBps Maximum allowable deviation (e.g., 150 bps = 1.5%)
   */
  public static detectManipulation(
    spotPrice: number,
    twapPrice: number,
    maxThresholdBps: number = 150
  ): { isManipulated: boolean; deviationBps: number; recommendation: 'ABORT_TRANSACTION' | 'SAFE_EXECUTE' } {
    if (twapPrice <= 0) {
      return { isManipulated: true, deviationBps: 9999, recommendation: 'ABORT_TRANSACTION' };
    }

    const diff = Math.abs(spotPrice - twapPrice);
    const deviationBps = Math.round((diff / twapPrice) * 10000);

    const isManipulated = deviationBps > maxThresholdBps;

    return {
      isManipulated,
      deviationBps,
      recommendation: isManipulated ? 'ABORT_TRANSACTION' : 'SAFE_EXECUTE',
    };
  }
}
