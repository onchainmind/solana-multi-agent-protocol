/**
 * Agent Neo — Dynamic Priority Fee & Compute Unit Optimizer (Anti-Sandwich Defense)
 *
 * Sharpness Feature:
 * Calculates real-time competitive priority fees from recent prioritization fee samples,
 * ensuring fast block inclusion and reducing sandwich/MEV exposure.
 *
 * Mathematical Invariant:
 * - Priority fee is clamped between `[minPriorityFee, maxPriorityFee]`.
 * - Computes exact Nth percentile (e.g. 75th percentile) from recent slot observations.
 */

export interface PriorityOptimizerConfig {
  enabled: boolean;
  targetPercentile: number; // e.g. 75 for 75th percentile
  minPriorityFeeMicroLamports: number;
  maxPriorityFeeMicroLamports: number;
  defaultCuLimit: number;
  cuSafetyBufferPct: number; // e.g. 10 for 10% safety margin above simulated CUs
}

export const DEFAULT_PRIORITY_OPTIMIZER_CONFIG: PriorityOptimizerConfig = {
  enabled: true,
  targetPercentile: 75,
  minPriorityFeeMicroLamports: 10_000,
  maxPriorityFeeMicroLamports: 1_000_000,
  defaultCuLimit: 400_000,
  cuSafetyBufferPct: 10,
};

export interface PrioritizationFeeSample {
  slot: number;
  prioritizationFee: number;
}

export function calculateDynamicPriorityFee(
  samples: PrioritizationFeeSample[],
  config: PriorityOptimizerConfig = DEFAULT_PRIORITY_OPTIMIZER_CONFIG
): {
  optimalPriorityFee: number;
  sampleCount: number;
  percentileRank: number;
} {
  if (!config.enabled || !samples || samples.length === 0) {
    return {
      optimalPriorityFee: config.minPriorityFeeMicroLamports,
      sampleCount: 0,
      percentileRank: config.targetPercentile,
    };
  }

  // Sort fees in ascending order
  const sortedFees = samples
    .map((s) => s.prioritizationFee)
    .filter((f) => !isNaN(f) && f >= 0)
    .sort((a, b) => a - b);

  if (sortedFees.length === 0) {
    return {
      optimalPriorityFee: config.minPriorityFeeMicroLamports,
      sampleCount: 0,
      percentileRank: config.targetPercentile,
    };
  }

  // Compute percentile index
  const index = Math.min(
    sortedFees.length - 1,
    Math.max(0, Math.floor((config.targetPercentile / 100) * (sortedFees.length - 1)))
  );

  const percentileFee = sortedFees[index];

  // Clamp within bounds
  const optimalPriorityFee = Math.min(
    Math.max(percentileFee, config.minPriorityFeeMicroLamports),
    config.maxPriorityFeeMicroLamports
  );

  return {
    optimalPriorityFee,
    sampleCount: sortedFees.length,
    percentileRank: config.targetPercentile,
  };
}

export function calculateOptimizedComputeUnits(
  simulatedUnits: number,
  config: PriorityOptimizerConfig = DEFAULT_PRIORITY_OPTIMIZER_CONFIG
): number {
  if (simulatedUnits <= 0) {
    return config.defaultCuLimit;
  }
  const buffered = Math.round(simulatedUnits * (1 + config.cuSafetyBufferPct / 100));
  // Bound between 10,000 and 1,400,000
  return Math.min(Math.max(buffered, 10_000), 1_400_000);
}

