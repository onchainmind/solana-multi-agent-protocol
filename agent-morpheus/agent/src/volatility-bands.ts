/**
 * Morpheus Engine: Dynamic Volatility Band Calculator
 * Derives optimal CLMM range width using Bollinger Bands & Average True Range (ATR)
 */

export class VolatilityBandCalculator {
  /**
   * Compute dynamic range width in ticks based on price volatility
   * In low-volatility regimes: tighter bands (higher fee concentration)
   * In high-volatility regimes: wider bands (prevents frequent costly rebalances)
   */
  public static calculateDynamicWidth(
    historicalPrices: number[],
    baseWidthTicks: number = 200,
    minWidthTicks: number = 60,
    maxWidthTicks: number = 800
  ): { dynamicWidthTicks: number; standardDeviation: number; annualizedVol: number } {
    if (historicalPrices.length < 2) {
      return { dynamicWidthTicks: baseWidthTicks, standardDeviation: 0, annualizedVol: 0 };
    }

    const n = historicalPrices.length;
    const mean = historicalPrices.reduce((a, b) => a + b, 0) / n;
    const variance = historicalPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / (n - 1);
    const stdDev = Math.sqrt(variance);

    // Annualized volatility estimate (assuming hourly prices: sqrt(24 * 365))
    const volHourly = stdDev / mean;
    const annualizedVol = volHourly * Math.sqrt(8760);

    // Scale range width proportionally to volatility
    const scaleFactor = Math.max(0.5, Math.min(3.0, annualizedVol / 0.65)); // 65% annualized baseline
    const dynamicWidth = Math.round(baseWidthTicks * scaleFactor);

    return {
      dynamicWidthTicks: Math.max(minWidthTicks, Math.min(maxWidthTicks, dynamicWidth)),
      standardDeviation: parseFloat(stdDev.toFixed(4)),
      annualizedVol: parseFloat(annualizedVol.toFixed(2)),
    };
  }
}
