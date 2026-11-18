/**
 * Neo Engine: Dynamic Priority Fee Bidding Optimizer
 * Queries getRecentPrioritizationFees across recent slots and computes the optimal percentile bid.
 */

export class PriorityBiddingOptimizer {
  /**
   * Calculate competitive compute unit price (micro-lamports) for fast inclusion
   */
  public static calculateOptimalFee(
    recentFees: { slot: number; prioritizationFee: number }[],
    percentileTarget: number = 75
  ): { microLamportsPerCU: number; percentile: number; isCongested: boolean } {
    if (!recentFees || recentFees.length === 0) {
      return { microLamportsPerCU: 50_000, percentile: 75, isCongested: false };
    }

    const fees = recentFees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
    const index = Math.min(fees.length - 1, Math.floor((percentileTarget / 100) * fees.length));
    const targetFee = fees[index];

    // Detect network congestion spikes
    const medianFee = fees[Math.floor(fees.length / 2)];
    const isCongested = targetFee > medianFee * 3 && targetFee > 200_000;

    return {
      microLamportsPerCU: Math.max(10_000, targetFee),
      percentile: percentileTarget,
      isCongested,
    };
  }
}
