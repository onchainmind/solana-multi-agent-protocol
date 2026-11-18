import { expect } from "chai";
import { calculateAdaptiveDcaAmount, DEFAULT_VOLATILITY_CONFIG } from "../agent/src/volatility";

describe("Agent Trinity — Volatility-Adaptive DCA Engine", () => {
  const baseDca = 100_000_000; // 100 USDC (6 decimals)
  const price = 150.0; // $150 SOL/USD

  it("scales UP trade size during calm market conditions (low confidence spread)", () => {
    // 0.05% confidence spread (7.5 bps vs 15 bps baseline) -> Calmer than baseline
    const confidence = 0.075;
    const result = calculateAdaptiveDcaAmount(baseDca, price, confidence);

    expect(result.scaleFactor).to.be.greaterThan(1.0);
    expect(result.adjustedAmount).to.be.greaterThan(baseDca);
    expect(result.scaleFactor).to.be.at.most(DEFAULT_VOLATILITY_CONFIG.maxScale);
  });

  it("scales DOWN trade size during turbulent market conditions (high confidence spread)", () => {
    // 0.5% confidence spread (75 bps vs 15 bps baseline) -> More volatile
    const confidence = 0.75;
    const result = calculateAdaptiveDcaAmount(baseDca, price, confidence);

    expect(result.scaleFactor).to.be.lessThan(1.0);
    expect(result.adjustedAmount).to.be.lessThan(baseDca);
    expect(result.scaleFactor).to.be.at.least(DEFAULT_VOLATILITY_CONFIG.minScale);
  });

  it("strictly enforces minScale and maxScale boundaries", () => {
    // Extreme calm: confidence = 0
    const superCalm = calculateAdaptiveDcaAmount(baseDca, price, 0.0);
    expect(superCalm.scaleFactor).to.be.at.most(1.5);
    expect(superCalm.adjustedAmount).to.equal(150_000_000);

    // Extreme chaos: confidence = $50 on $150
    const superChaos = calculateAdaptiveDcaAmount(baseDca, price, 50.0);
    expect(superChaos.scaleFactor).to.be.at.least(0.5);
    expect(superChaos.adjustedAmount).to.equal(50_000_000);
  });

  it("returns base amount when volatility adaptation is disabled", () => {
    const disabledResult = calculateAdaptiveDcaAmount(baseDca, price, 10.0, {
      ...DEFAULT_VOLATILITY_CONFIG,
      enabled: false,
    });
    expect(disabledResult.adjustedAmount).to.equal(baseDca);
    expect(disabledResult.scaleFactor).to.equal(1.0);
  });
});

