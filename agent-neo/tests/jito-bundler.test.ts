import { expect } from 'chai';
import { JitoBundler } from '../agent/src/jito-bundler';
import { SandwichSimulator } from '../agent/src/sandwich-simulator';
import { PriorityBiddingOptimizer } from '../agent/src/priority-bidding';

describe('Neo: Jito Bundler & Anti-Sandwich Protection Tests', () => {
  it('should return a valid Jito block engine endpoint and tip account', () => {
    const engineUrl = JitoBundler.getOptimalBlockEngine();
    expect(engineUrl).to.include('block-engine.jito.wtf');

    const tipAccount = JitoBundler.getRandomTipAccount();
    expect(tipAccount).to.be.a('string');
    expect(tipAccount.length).to.be.greaterThan(30);
  });

  it('should calculate appropriate dynamic tip for high-value trade', () => {
    const tipLamports = JitoBundler.calculateTip(50, 0.5); // 50 SOL trade with 0.5 SOL arb
    expect(tipLamports).to.be.greaterThanOrEqual(10_000);
  });

  it('should recommend mandatory Jito bundle execution for high slippage risk', () => {
    const evaluation = SandwichSimulator.evaluateRisk(100_000, 200_000, 150); // Large impact & 150 bps slippage
    expect(evaluation.riskLevel).to.equal('CRITICAL');
    expect(evaluation.recommendedExecution).to.equal('JITO_BUNDLE_MANDATORY');
  });

  it('should calculate 75th percentile priority fee during congestion', () => {
    const feeSamples = [
      { slot: 100, prioritizationFee: 10_000 },
      { slot: 101, prioritizationFee: 20_000 },
      { slot: 102, prioritizationFee: 30_000 },
      { slot: 103, prioritizationFee: 200_000 },
    ];
    const optimal = PriorityBiddingOptimizer.calculateOptimalFee(feeSamples, 75);
    expect(optimal.microLamportsPerCU).to.be.greaterThanOrEqual(30_000);
  });
});
