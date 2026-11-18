/**
 * Cypher Engine: Liquid Staking Token (LST) Yield Harvester & Router
 * Continuously evaluates APYs across Marinade (mSOL), Jito (JitoSOL), and BlazeStake (bSOL),
 * dynamically rebalancing vault reserves into the highest-yielding liquid staking pool.
 */

export interface LstPoolApy {
  poolName: 'Marinade' | 'Jito' | 'BlazeStake';
  tokenMint: string;
  currentApyPct: number;
  mevRewardsApyPct: number;
  totalApyPct: number;
  exchangeRateToSol: number;
  depegDiscountBps: number;
}

export class StakeYieldRouter {
  public static selectOptimalLst(pools: LstPoolApy[], maxDepegBps: number = 50): LstPoolApy | null {
    // Filter out pools suffering from severe depeg (> 50 bps)
    const validPools = pools.filter((p) => p.depegDiscountBps <= maxDepegBps);
    if (validPools.length === 0) return null;

    // Sort by highest combined APY (Base staking + MEV rewards)
    validPools.sort((a, b) => b.totalApyPct - a.totalApyPct);
    return validPools[0];
  }
}
