import { expect } from 'chai';
import { MultiSourceOracleAggregator, OracleFeedReport } from '../agent/src/oracle-consensus';
import { FlashLoanDetector } from '../agent/src/flashloan-detector';
import { MomentumPredictor } from '../agent/src/momentum-predictor';

describe('Oracle: Multi-Source Aggregator & Anomaly Detector Tests', () => {
  it('should compute robust median consensus price across active feeds', () => {
    const aggregator = new MultiSourceOracleAggregator(60, 100);
    const now = Math.floor(Date.now() / 1000);

    const feeds: OracleFeedReport[] = [
      { source: 'Pyth', symbol: 'SOL/USD', price: 150.2, confidence: 0.05, publishTime: now - 5, slot: 200 },
      { source: 'Switchboard', symbol: 'SOL/USD', price: 150.1, confidence: 0.08, publishTime: now - 3, slot: 201 },
      { source: 'Chainlink', symbol: 'SOL/USD', price: 150.3, confidence: 0.04, publishTime: now - 2, slot: 202 },
    ];

    const consensus = aggregator.computeConsensus(feeds, now);
    expect(consensus.isValid).to.be.true;
    expect(consensus.medianPrice).to.equal(150.2);
    expect(consensus.status).to.equal('CONSENSUS_HEALTHY');
  });

  it('should trigger alert when oracles diverge beyond threshold', () => {
    const aggregator = new MultiSourceOracleAggregator(60, 50); // 50 bps max
    const now = Math.floor(Date.now() / 1000);

    const feeds: OracleFeedReport[] = [
      { source: 'Pyth', symbol: 'SOL/USD', price: 150.0, confidence: 0.05, publishTime: now, slot: 200 },
      { source: 'Switchboard', symbol: 'SOL/USD', price: 153.0, confidence: 0.08, publishTime: now, slot: 200 }, // 2% higher!
    ];

    const consensus = aggregator.computeConsensus(feeds, now);
    expect(consensus.isValid).to.be.false;
    expect(consensus.status).to.equal('DIVERGENCE_ALERT');
  });

  it('should detect flash-loan manipulation when spot diverges from TWAP', () => {
    const spotPrice = 175.0;
    const twapPrice = 150.0;
    const detection = FlashLoanDetector.detectManipulation(spotPrice, twapPrice, 150);
    expect(detection.isManipulated).to.be.true;
    expect(detection.recommendation).to.equal('ABORT_TRANSACTION');
  });
});
