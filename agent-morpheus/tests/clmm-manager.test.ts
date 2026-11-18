import { expect } from 'chai';
import { CLMMManager, CLMMPosition } from '../agent/src/clmm-manager';
import { VolatilityBandCalculator } from '../agent/src/volatility-bands';
import { ImpermanentLossHedger } from '../agent/src/il-hedger';

describe('Morpheus: CLMM Active Range & IL Hedger Unit Tests', () => {
  it('should correctly calculate tick to price and price to tick conversions', () => {
    const tick = 0;
    const price = CLMMManager.tickToPrice(tick, 9, 6);
    expect(price).to.equal(1000);

    const calculatedTick = CLMMManager.priceToTick(price, 9, 6);
    expect(calculatedTick).to.equal(0);
  });

  it('should recommend rebalance when position tick moves out of range', () => {
    const manager = new CLMMManager();
    const position: CLMMPosition = {
      poolAddress: 'Whirlpool1111111111111111111111111111111111',
      tokenA: 'SOL',
      tokenB: 'USDC',
      lowerTick: -100,
      upperTick: 100,
      currentTick: 150, // Out of range!
      liquidity: BigInt(1000000),
      feeTierBps: 25,
      uncollectedFeesA: 0.5,
      uncollectedFeesB: 50,
    };

    const rec = manager.evaluatePosition(position, 200);
    expect(rec.requiresRebalance).to.be.true;
    expect(rec.reason).to.equal('OUT_OF_RANGE');
    expect(rec.newLowerTick).to.equal(50);
    expect(rec.newUpperTick).to.equal(250);
  });

  it('should calculate impermanent loss and propose hedging actions', () => {
    const il = ImpermanentLossHedger.calculateConcentratedIL(160, 140, 120, 180);
    expect(il.ilPercentage).to.be.a('number');
    expect(il.hedgeAction).to.be.oneOf(['INCREASE_SHORT', 'DECREASE_SHORT', 'HOLD']);
  });
});
