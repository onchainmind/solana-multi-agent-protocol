/**
 * Oracle Engine: Predictive Trend & Momentum Scoring (EMA Cross + VWAP)
 * Generates forward-looking directional trade signals for automated protocol rebalancing.
 */

export class MomentumPredictor {
  /**
   * Calculate Exponential Moving Average (EMA)
   */
  public static calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  /**
   * Derive directional momentum score [-100 to +100]
   */
  public static scoreMomentum(
    priceSeries: number[],
    currentVwap: number
  ): { score: number; trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; signal: 'ACCUMULATE' | 'DISTRIBUTE' | 'HOLD' } {
    if (priceSeries.length < 26) {
      return { score: 0, trend: 'NEUTRAL', signal: 'HOLD' };
    }

    const emaFast = this.calculateEMA(priceSeries, 12);
    const emaSlow = this.calculateEMA(priceSeries, 26);
    const currentPrice = priceSeries[priceSeries.length - 1];

    const emaDiffPct = ((emaFast - emaSlow) / emaSlow) * 100;
    const vwapDiffPct = ((currentPrice - currentVwap) / currentVwap) * 100;

    const rawScore = Math.round(emaDiffPct * 30 + vwapDiffPct * 40);
    const clampedScore = Math.max(-100, Math.min(100, rawScore));

    let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    let signal: 'ACCUMULATE' | 'DISTRIBUTE' | 'HOLD' = 'HOLD';

    if (clampedScore > 25) {
      trend = 'BULLISH';
      signal = 'ACCUMULATE';
    } else if (clampedScore < -25) {
      trend = 'BEARISH';
      signal = 'DISTRIBUTE';
    }

    return { score: clampedScore, trend, signal };
  }
}
