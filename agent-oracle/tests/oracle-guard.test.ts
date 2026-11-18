import { expect } from "chai";
import { validateOracleDivergence, DEFAULT_ORACLE_GUARD_CONFIG } from "../agent/src/oracle-guard";

describe("Agent Oracle — Dual-Oracle Cross-Validation Guard", () => {
  it("approves execution when spot price aligns closely with EMA", () => {
    const spot = 150.25;
    const ema = 150.0; // Divergence: 25 cents on $150 = ~16 bps (< 200 bps threshold)

    const result = validateOracleDivergence(spot, ema);
    expect(result.isSafe).to.be.true;
    expect(result.anomalyDetected).to.be.false;
    expect(result.divergenceBps).to.be.lessThan(DEFAULT_ORACLE_GUARD_CONFIG.maxDivergenceBps);
  });

  it("detects and blocks flash-loan spikes where spot sharply deviates from EMA", () => {
    const spot = 156.0; // Flash spike: +$6.00 (+4.0%)
    const ema = 150.0;

    const result = validateOracleDivergence(spot, ema);
    expect(result.isSafe).to.be.false;
    expect(result.anomalyDetected).to.be.true;
    expect(result.divergenceBps).to.equal(400); // 400 bps > 200 bps
    expect(result.reason).to.include("Oracle divergence breach");
  });

  it("rejects invalid or non-positive price inputs", () => {
    const result = validateOracleDivergence(-10, 150);
    expect(result.isSafe).to.be.false;
    expect(result.anomalyDetected).to.be.true;
  });
});

