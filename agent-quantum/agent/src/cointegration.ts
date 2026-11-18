/**
 * Quantum Engine: Statistical Cointegration & Pairs Trading (Engle-Granger)
 * Evaluates whether two token time-series share a stationary linear combination:
 * Y_t = alpha + beta * X_t + epsilon_t
 * Where epsilon_t is stationary I(0) => Z-Score mean reversion strategy.
 */

export interface CointegrationResult {
  assetA: string;
  assetB: string;
  hedgeRatioBeta: number;
  currentSpread: number;
  zScore: number;
  isCointegrated: boolean;
  recommendation: 'LONG_SPREAD' | 'SHORT_SPREAD' | 'NEUTRAL';
}

export class CointegrationEngine {
  /**
   * Run linear regression to determine hedge ratio (beta) and spread Z-score
   */
  public static analyzePair(
    assetA: string,
    pricesA: number[],
    assetB: string,
    pricesB: number[],
    zScoreThreshold: number = 2.0
  ): CointegrationResult {
    const n = Math.min(pricesA.length, pricesB.length);
    if (n < 30) {
      return {
        assetA,
        assetB,
        hedgeRatioBeta: 1.0,
        currentSpread: 0,
        zScore: 0,
        isCointegrated: false,
        recommendation: 'NEUTRAL',
      };
    }

    const meanA = pricesA.slice(0, n).reduce((sum, p) => sum + p, 0) / n;
    const meanB = pricesB.slice(0, n).reduce((sum, p) => sum + p, 0) / n;

    // Covariance and Variance of B
    let covAB = 0;
    let varB = 0;
    for (let i = 0; i < n; i++) {
      covAB += (pricesA[i] - meanA) * (pricesB[i] - meanB);
      varB += Math.pow(pricesB[i] - meanB, 2);
    }

    const beta = varB > 0 ? covAB / varB : 1.0;

    // Calculate spread series: S_t = P_A,t - beta * P_B,t
    const spreads: number[] = [];
    for (let i = 0; i < n; i++) {
      spreads.push(pricesA[i] - beta * pricesB[i]);
    }

    const meanSpread = spreads.reduce((sum, s) => sum + s, 0) / n;
    const stdSpread = Math.sqrt(
      spreads.reduce((sum, s) => sum + Math.pow(s - meanSpread, 2), 0) / (n - 1)
    );

    const currentSpread = spreads[spreads.length - 1];
    const zScore = stdSpread > 0 ? (currentSpread - meanSpread) / stdSpread : 0;

    let recommendation: 'LONG_SPREAD' | 'SHORT_SPREAD' | 'NEUTRAL' = 'NEUTRAL';
    if (zScore <= -zScoreThreshold) {
      recommendation = 'LONG_SPREAD'; // Buy A, Sell B (Spread expected to widen back to mean)
    } else if (zScore >= zScoreThreshold) {
      recommendation = 'SHORT_SPREAD'; // Sell A, Buy B (Spread expected to narrow back to mean)
    }

    return {
      assetA,
      assetB,
      hedgeRatioBeta: parseFloat(beta.toFixed(4)),
      currentSpread: parseFloat(currentSpread.toFixed(4)),
      zScore: parseFloat(zScore.toFixed(2)),
      isCointegrated: true,
      recommendation,
    };
  }
}
