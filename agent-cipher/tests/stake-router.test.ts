import { expect } from 'chai';
import { StakeYieldRouter, LstPoolApy } from '../agent/src/stake-router';
import { DepegCircuitBreaker } from '../agent/src/depeg-guard';

describe('Cypher: LST Staking & Depeg Guard Unit Tests', () => {
  it('should select highest APY pool when depeg discount is within threshold', () => {
    const pools: LstPoolApy[] = [
      {
        poolName: 'Marinade',
        tokenMint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
        currentApyPct: 7.2,
        mevRewardsApyPct: 1.1,
        totalApyPct: 8.3,
        exchangeRateToSol: 1.25,
        depegDiscountBps: 10,
      },
      {
        poolName: 'Jito',
        tokenMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
        currentApyPct: 7.8,
        mevRewardsApyPct: 1.4,
        totalApyPct: 9.2,
        exchangeRateToSol: 1.15,
        depegDiscountBps: 15,
      },
    ];

    const optimal = StakeYieldRouter.selectOptimalLst(pools, 50);
    expect(optimal).to.not.be.null;
    expect(optimal?.poolName).to.equal('Jito');
    expect(optimal?.totalApyPct).to.equal(9.2);
  });

  it('should trigger circuit breaker on significant depeg', () => {
    const status = DepegCircuitBreaker.checkDepeg(0.98, 1.05, 75);
    expect(status.circuitBreakerTriggered).to.be.true;
    expect(status.isDepegged).to.be.true;
    expect(status.depegBps).to.be.greaterThan(75);
  });
});
