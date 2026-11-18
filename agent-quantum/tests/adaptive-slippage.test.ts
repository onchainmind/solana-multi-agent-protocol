import { expect } from "chai";
import {
  calculateAdaptiveSlippage,
  DEFAULT_ADAPTIVE_SLIPPAGE_CONFIG,
} from "../agent/src/adaptive-slippage";

describe("Agent Quantum — Liquidity Depth & Adaptive Slippage Engine", () => {
  it("tightens slippage on deep pools with negligible price impact", () => {
    // 0.02% price impact (2 bps) -> calculated 2 * 1.25 = 2.5 bps -> clamped to min 10 bps
    const result = calculateAdaptiveSlippage(0.02);
    expect(result.optimalSlippageBps).to.equal(DEFAULT_ADAPTIVE_SLIPPAGE_CONFIG.minSlippageBps);
    expect(result.strategy).to.equal("TIGHTENED");
  });

  it("scales slippage proportionally for moderate liquidity multi-hop routes", () => {
    // 0.40% price impact (40 bps) -> 40 * 1.25 = 50 bps
    const result = calculateAdaptiveSlippage(0.4);
    expect(result.optimalSlippageBps).to.equal(50);
    expect(result.strategy).to.equal("PROPORTIONAL");
  });

  it("caps maximum slippage on shallow liquidity to prevent adverse execution", () => {
    // 2.5% price impact (250 bps) -> 250 * 1.25 = 312.5 bps -> clamped to max 200 bps
    const result = calculateAdaptiveSlippage(2.5);
    expect(result.optimalSlippageBps).to.equal(DEFAULT_ADAPTIVE_SLIPPAGE_CONFIG.maxSlippageBps);
    expect(result.strategy).to.equal("CAPPED");
  });
});

