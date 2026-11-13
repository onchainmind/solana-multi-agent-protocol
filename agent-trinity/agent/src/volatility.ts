/**
 * Agent Trinity — Volatility-Adaptive DCA Engine
 *
 * Sharpness Feature:
 * Dynamically adjusts DCA order size based on real-time Pyth price confidence
 * and implied market volatility.
 *
 * Mathematical Invariant:
 * - Low Volatility / High Confidence: Scale up trade size up to +50% (1.5x)
 * - High Volatility / Low Confidence: Scale down trade size down to -50% (0.5x)
 * - Trade size is strictly bounded: [baseAmount * 0.5, baseAmount * 1.5]
 */

export interface VolatilityConfig {
  enabled: boolean;
  /** Baseline confidence threshold in basis points (e.g. 15 bps = 0.15%). */
  baselineConfidenceBps: number;
  /** Sensitivity scaling factor (default: 1.0). */
  sensitivity: number;
  /** Minimum scale factor (default: 0.5). */
  minScale: number;
  /** Maximum scale factor (default: 1.5). */
  maxScale: number;
}

export const DEFAULT_VOLATILITY_CONFIG: VolatilityConfig = {
  enabled: true,
  baselineConfidenceBps: 15, // 0.15% confidence interval
  sensitivity: 1.0,
  minScale: 0.5,
  maxScale: 1.5,
};

/**
 * Calculates adaptive trade size based on Pyth price and confidence interval.
 *
 * @param baseAmount Target DCA amount in raw units (e.g. USDC atomic units)
 * @param price Current Pyth oracle price
 * @param confidence Current Pyth oracle confidence interval
 * @param config Volatility adjustment parameters
 * @returns Adaptive trade amount bounded within [minScale * base, maxScale * base]
 */
export function calculateAdaptiveDcaAmount(
  baseAmount: number,
  price: number,
  confidence: number,
  config: VolatilityConfig = DEFAULT_VOLATILITY_CONFIG
): {
  adjustedAmount: number;
  scaleFactor: number;
  confidenceBps: number;
} {
  if (!config.enabled || price <= 0 || baseAmount <= 0) {
    return {
      adjustedAmount: baseAmount,
      scaleFactor: 1.0,
      confidenceBps: 0,
    };
  }

  // Calculate current confidence spread in basis points: (confidence / price) * 10,000
  const confidenceBps = Math.round((confidence / price) * 10_000);

  let scaleFactor = 1.0;
  if (confidenceBps < config.baselineConfidenceBps) {
    // Calmer than baseline: scale up towards maxScale
    const calmRatio = (config.baselineConfidenceBps - confidenceBps) / config.baselineConfidenceBps;
    scaleFactor = 1.0 + calmRatio * (config.maxScale - 1.0) * config.sensitivity;
  } else if (confidenceBps > config.baselineConfidenceBps) {
    // More volatile than baseline: scale down towards minScale
    const volatileRatio = (confidenceBps - config.baselineConfidenceBps) / config.baselineConfidenceBps;
    scaleFactor = 1.0 - volatileRatio * (1.0 - config.minScale) * config.sensitivity;
  }

  // Strictly clamp within bounds [minScale, maxScale]
  scaleFactor = Math.min(Math.max(scaleFactor, config.minScale), config.maxScale);

  // Calculate integer adjusted amount
  const adjustedAmount = Math.max(1, Math.round(baseAmount * scaleFactor));

  return {
    adjustedAmount,
    scaleFactor: Number(scaleFactor.toFixed(3)),
    confidenceBps,
  };
}
