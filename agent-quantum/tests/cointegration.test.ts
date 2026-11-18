import { expect } from 'chai';
import { CointegrationEngine } from '../agent/src/cointegration';
import { BasisHarvester } from '../agent/src/basis-harvester';
import { ZScoreExecutionManager } from '../agent/src/zscore-execution';

describe('Quantum: Cointegration & Basis Yield Engine Tests', () => {
  it('should compute cointegration hedge ratio beta and spread Z-score', () => {
    // Generate 40 correlated synthetic prices
    const pricesA: number[] = [];
    const pricesB: number[] = [];
    for (let i = 0; i < 40; i++) {
      const base = 100 + i * 0.5;
      pricesB.push(base);
      pricesA.push(base * 1.05 + (i % 2 === 0 ? 0.2 : -0.2));
    }

    const result = CointegrationEngine.analyzePair('mSOL', pricesA, 'SOL', pricesB, 2.0);
    expect(result.isCointegrated).to.be.true;
    expect(result.hedgeRatioBeta).to.be.closeTo(1.05, 0.1);
    expect(result.zScore).to.be.a('number');
  });

  it('should evaluate cash-and-carry basis trade profitability', () => {
    const quote = {
      market: 'SOL-PERP',
      spotPrice: 150.0,
      perpPrice: 150.8,
      hourlyFundingRate: 0.0003, // 0.03% per hour
      annualizedApy: 32.5,
    };

    const evaluation = BasisHarvester.evaluateBasisTrade(quote, 6.0, 15.0);
    expect(evaluation.isExecutable).to.be.true;
    expect(evaluation.strategy).to.equal('ENTER_CASH_AND_CARRY');
    expect(evaluation.netApy).to.be.greaterThan(20.0);
  });

  it('should trigger take profit when Z-score mean reverts near 0', () => {
    const action = ZScoreExecutionManager.checkLifecycle(0.1, 'LONG_SPREAD', 0.25, 3.5);
    expect(action.action).to.equal('TAKE_PROFIT');
  });
});
