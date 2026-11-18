/**
 * Neo Engine: Pre-Flight Sandwich Attack Simulator
 * Analyzes pending transactions and pool liquidity depth to evaluate sandwich exploit vulnerability.
 */

export class SandwichSimulator {
  /**
   * Evaluate sandwich exploit risk for a given trade size and slippage tolerance
   * @param tradeSizeUsd Notional value of the swap
   * @param poolLiquidityUsd Total pool liquidity
   * @param maxSlippageBps User-configured slippage limit
   */
  public static evaluateRisk(
    tradeSizeUsd: number,
    poolLiquidityUsd: number,
    maxSlippageBps: number
  ): {
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    expectedSlippageLossUsd: number;
    recommendedExecution: 'PUBLIC_RPC' | 'JITO_BUNDLE_MANDATORY';
  } {
    const impactPct = (tradeSizeUsd / poolLiquidityUsd) * 100;
    const slippageLossUsd = tradeSizeUsd * (maxSlippageBps / 10000);

    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
    let recommendedExecution: 'PUBLIC_RPC' | 'JITO_BUNDLE_MANDATORY' = 'PUBLIC_RPC';

    if (impactPct > 1.5 || maxSlippageBps > 100) {
      riskLevel = 'CRITICAL';
      recommendedExecution = 'JITO_BUNDLE_MANDATORY';
    } else if (impactPct > 0.5 || maxSlippageBps > 50) {
      riskLevel = 'HIGH';
      recommendedExecution = 'JITO_BUNDLE_MANDATORY';
    } else if (impactPct > 0.1) {
      riskLevel = 'MEDIUM';
    }

    return {
      riskLevel,
      expectedSlippageLossUsd: parseFloat(slippageLossUsd.toFixed(2)),
      recommendedExecution,
    };
  }
}
