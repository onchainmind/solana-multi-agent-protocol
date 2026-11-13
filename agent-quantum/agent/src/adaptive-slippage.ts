/**
 * Agent Quantum — Liquidity Depth Scorer & Adaptive Slippage Calculator
 *
 * Sharpness Feature:
 * Replaces static slippage with dynamic price-impact-adjusted slippage.
 * Tightens slippage on deep liquid pools to prevent MEV extraction, while
 * widening slippage proportionally on multi-hop routes to prevent transaction reverts.
 *
 * Mathematical Invariant:
 * - Slippage is strictly bounded between `[minSlippageBps, maxSlippageBps]`.
 * - Dynamic formula: `clamp(priceImpactBps * impactMultiplier, minBps, maxBps)`.
 */

export interface AdaptiveSlippageConfig {
  enabled: boolean;
  minSlippageBps: number; // e.g. 10 bps (0.10%)
  maxSlippageBps: number; // e.g. 200 bps (2.00%)
  impactMultiplier: number; // e.g. 1.25 (125% of expected price impact)
  defaultSlippageBps: number;
}

export const DEFAULT_ADAPTIVE_SLIPPAGE_CONFIG: AdaptiveSlippageConfig = {
  enabled: true,
  minSlippageBps: 10,
  maxSlippageBps: 200,
  impactMultiplier: 1.25,
  defaultSlippageBps: 50,
};

export function calculateAdaptiveSlippage(
  priceImpactPct: number, // e.g. 0.04 for 0.04% price impact
  config: AdaptiveSlippageConfig = DEFAULT_ADAPTIVE_SLIPPAGE_CONFIG
): {
  optimalSlippageBps: number;
  priceImpactBps: number;
  strategy: "TIGHTENED" | "PROPORTIONAL" | "CAPPED";
} {
  if (!config.enabled || isNaN(priceImpactPct) || priceImpactPct < 0) {
    return {
      optimalSlippageBps: config.defaultSlippageBps,
      priceImpactBps: 0,
      strategy: "PROPORTIONAL",
    };
  }

  // Convert percentage (e.g. 0.05% = 5 bps)
  const priceImpactBps = Math.round(priceImpactPct * 100);

  // Scaled impact: impact * multiplier
  const calculatedBps = Math.round(priceImpactBps * config.impactMultiplier);

  let strategy: "TIGHTENED" | "PROPORTIONAL" | "CAPPED" = "PROPORTIONAL";

  let optimalSlippageBps = calculatedBps;
  if (calculatedBps <= config.minSlippageBps) {
    optimalSlippageBps = config.minSlippageBps;
    strategy = "TIGHTENED";
  } else if (calculatedBps >= config.maxSlippageBps) {
    optimalSlippageBps = config.maxSlippageBps;
    strategy = "CAPPED";
  }

  return {
    optimalSlippageBps,
    priceImpactBps,
    strategy,
  };
}

