/**
 * Cypher Engine: LST Depeg Circuit Breaker & Slashing Protection Guard
 * Halts rebalancing and triggers defensive redemptions if an LST's market price
 * diverges significantly from its on-chain validator pool backing.
 */

export class DepegCircuitBreaker {
  public static checkDepeg(
    marketPriceSol: number,
    fairBackingPriceSol: number,
    maxAllowedDepegBps: number = 75
  ): { isDepegged: boolean; depegBps: number; circuitBreakerTriggered: boolean } {
    if (fairBackingPriceSol <= 0) {
      return { isDepegged: true, depegBps: 9999, circuitBreakerTriggered: true };
    }

    const discount = (fairBackingPriceSol - marketPriceSol) / fairBackingPriceSol;
    const depegBps = Math.round(discount * 10000);

    const isDepegged = depegBps > maxAllowedDepegBps;
    return {
      isDepegged,
      depegBps: Math.max(0, depegBps),
      circuitBreakerTriggered: isDepegged,
    };
  }
}
