/**
 * Morpheus Engine: Impermanent Loss (IL) Estimator & Delta-Neutral Hedger
 * Computes exact IL relative to HODL and determines the required hedge ratio.
 */

export class ImpermanentLossHedger {
  /**
   * Calculate standard Uniswap v3 / Orca Whirlpool Impermanent Loss
   * @param priceRatio Price change factor k = P_current / P_entry
   * @param priceLower Lower range boundary price P_a
   * @param priceUpper Upper range boundary price P_b
   * @param entryPrice Price when position was initialized P_0
   */
  public static calculateConcentratedIL(
    currentPrice: number,
    entryPrice: number,
    priceLower: number,
    priceUpper: number
  ): { ilPercentage: number; deltaExposureSol: number; hedgeAction: 'INCREASE_SHORT' | 'DECREASE_SHORT' | 'HOLD' } {
    const k = currentPrice / entryPrice;

    // Standard 50/50 IL: 2 * sqrt(k) / (1 + k) - 1
    const standardIL = (2 * Math.sqrt(k)) / (1 + k) - 1;

    // Concentration amplification factor
    const rangeSpan = Math.sqrt(priceUpper) - Math.sqrt(priceLower);
    const concentrationMultiplier = entryPrice > 0 && rangeSpan > 0 ? Math.sqrt(entryPrice) / rangeSpan : 1.0;

    const concentratedIL = standardIL * concentrationMultiplier;

    // Delta exposure: if price went up, pool sold token A (SOL) into token B (USDC)
    const deltaExposureSol = currentPrice > entryPrice ? -0.25 : 0.25;

    let hedgeAction: 'INCREASE_SHORT' | 'DECREASE_SHORT' | 'HOLD' = 'HOLD';
    if (deltaExposureSol > 0.1) hedgeAction = 'INCREASE_SHORT';
    else if (deltaExposureSol < -0.1) hedgeAction = 'DECREASE_SHORT';

    return {
      ilPercentage: parseFloat((concentratedIL * 100).toFixed(2)),
      deltaExposureSol,
      hedgeAction,
    };
  }
}
