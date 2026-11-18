import { expect } from "chai";
import {
  updateHighWaterMark,
  evaluateTrailingStop,
  TrailingStopState,
} from "../agent/src/trailing-stop";

describe("Agent Morpheus — Dynamic Trailing Stop-Loss Guard", () => {
  it("ratchets up the high-water mark as price rises", () => {
    let state: TrailingStopState = {
      entryPriceUsd: 100.0,
      peakPriceUsd: 100.0,
      trailingStopBps: 300, // 3% trailing stop
      isActive: true,
    };

    // Price rallies from $100 -> $110 -> $125
    state = updateHighWaterMark(state, 110.0);
    expect(state.peakPriceUsd).to.equal(110.0);

    state = updateHighWaterMark(state, 125.0);
    expect(state.peakPriceUsd).to.equal(125.0);

    // Price dips to $120 -> High-water mark remains $125
    state = updateHighWaterMark(state, 120.0);
    expect(state.peakPriceUsd).to.equal(125.0);
  });

  it("does not trigger exit while pullback is within trailing allowance", () => {
    const state: TrailingStopState = {
      entryPriceUsd: 100.0,
      peakPriceUsd: 120.0,
      trailingStopBps: 400, // 4% trailing allowance -> stop is 120 * 0.96 = 115.2
      isActive: true,
    };

    // Current price is $117 (2.5% pullback)
    const evalResult = evaluateTrailingStop(state, 117.0);
    expect(evalResult.shouldExit).to.be.false;
    expect(evalResult.effectiveStopPrice).to.equal(115.2);
    expect(evalResult.drawdownFromPeakBps).to.equal(250);
  });

  it("triggers profit-locking exit when price breaches the trailing threshold", () => {
    const state: TrailingStopState = {
      entryPriceUsd: 100.0,
      peakPriceUsd: 120.0,
      trailingStopBps: 400, // 4% trailing stop -> $115.2
      isActive: true,
    };

    // Price crashes through $115.2 to $114.0
    const evalResult = evaluateTrailingStop(state, 114.0);
    expect(evalResult.shouldExit).to.be.true;
    // Guaranteed profit over initial $100 entry: locked gain is approx +15.2%
    expect(evalResult.lockedGainBps).to.be.greaterThan(1400);
  });
});

