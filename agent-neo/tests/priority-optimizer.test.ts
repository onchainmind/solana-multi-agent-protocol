import { expect } from "chai";
import {
  calculateDynamicPriorityFee,
  calculateOptimizedComputeUnits,
  DEFAULT_PRIORITY_OPTIMIZER_CONFIG,
  PrioritizationFeeSample,
} from "../agent/src/priority-optimizer";

describe("Agent Neo — Dynamic Priority Fee & MEV Defense Optimizer", () => {
  it("calculates 75th percentile priority fee accurately from samples", () => {
    // 5 samples: 20k, 50k, 100k, 200k, 500k
    const samples: PrioritizationFeeSample[] = [
      { slot: 1, prioritizationFee: 20_000 },
      { slot: 2, prioritizationFee: 50_000 },
      { slot: 3, prioritizationFee: 100_000 },
      { slot: 4, prioritizationFee: 200_000 },
      { slot: 5, prioritizationFee: 500_000 },
    ];

    const result = calculateDynamicPriorityFee(samples);
    expect(result.optimalPriorityFee).to.equal(200_000);
    expect(result.sampleCount).to.equal(5);
  });

  it("clamps priority fee within min and max boundaries", () => {
    // Sample with very low fees below min boundary
    const lowSamples: PrioritizationFeeSample[] = [{ slot: 1, prioritizationFee: 500 }];
    const lowResult = calculateDynamicPriorityFee(lowSamples);
    expect(lowResult.optimalPriorityFee).to.equal(DEFAULT_PRIORITY_OPTIMIZER_CONFIG.minPriorityFeeMicroLamports);

    // Sample with exorbitant fee above max boundary
    const highSamples: PrioritizationFeeSample[] = [{ slot: 1, prioritizationFee: 50_000_000 }];
    const highResult = calculateDynamicPriorityFee(highSamples);
    expect(highResult.optimalPriorityFee).to.equal(DEFAULT_PRIORITY_OPTIMIZER_CONFIG.maxPriorityFeeMicroLamports);
  });

  it("applies safety buffer to simulated compute units", () => {
    // 200,000 simulated CUs + 10% buffer = 220,000 CUs
    const cu = calculateOptimizedComputeUnits(200_000);
    expect(cu).to.equal(220_000);
  });
});

