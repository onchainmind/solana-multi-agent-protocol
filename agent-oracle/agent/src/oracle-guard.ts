/**
 * Agent Oracle — Dual-Oracle Cross-Validation & Flash-Spike Filter
 *
 * Sharpness Feature:
 * Cross-validates real-time Pyth Spot Price against Pyth Exponential Moving
 * Average (EMA) price to filter out flash loans, oracle manipulation, and
 * publisher lag spikes before trade execution.
 *
 * Mathematical Invariant:
 * - If `|spot - ema| / ema > maxDivergenceBps`, execution is safely suppressed.
 */

export interface OracleGuardConfig {
  enabled: boolean;
  /** Maximum allowable divergence between spot and EMA price in bps (e.g. 200 = 2.0%). */
  maxDivergenceBps: number;
}

export const DEFAULT_ORACLE_GUARD_CONFIG: OracleGuardConfig = {
  enabled: true,
  maxDivergenceBps: 200, // 2% maximum allowable divergence
};

export function validateOracleDivergence(
  spotPrice: number,
  emaPrice: number,
  config: OracleGuardConfig = DEFAULT_ORACLE_GUARD_CONFIG
): {
  isSafe: boolean;
  divergenceBps: number;
  anomalyDetected: boolean;
  reason?: string;
} {
  if (!config.enabled) {
    return { isSafe: true, divergenceBps: 0, anomalyDetected: false };
  }

  if (spotPrice <= 0 || emaPrice <= 0) {
    return {
      isSafe: false,
      divergenceBps: 0,
      anomalyDetected: true,
      reason: "Invalid non-positive oracle price input",
    };
  }

  const diff = Math.abs(spotPrice - emaPrice);
  const divergenceBps = Math.round((diff / emaPrice) * 10_000);

  if (divergenceBps > config.maxDivergenceBps) {
    return {
      isSafe: false,
      divergenceBps,
      anomalyDetected: true,
      reason: `Oracle divergence breach: ${divergenceBps} bps exceeds max allowable ${config.maxDivergenceBps} bps`,
    };
  }

  return {
    isSafe: true,
    divergenceBps,
    anomalyDetected: false,
  };
}

