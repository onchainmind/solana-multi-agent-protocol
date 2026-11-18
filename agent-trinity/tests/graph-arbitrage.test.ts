import { expect } from 'chai';
import { GraphArbitrageEngine } from '../agent/src/graph-arbitrage';
import { SpatialArbitrageScanner, DexQuote } from '../agent/src/spatial-arb';

describe('Trinity: Graph Arbitrage & Spatial Scanner Unit Tests', () => {
  it('should detect a profitable triangular arbitrage negative cycle', () => {
    const engine = new GraphArbitrageEngine();

    // 1 SOL -> 150 USDC on Orca
    engine.addEdge({
      fromToken: 'SOL',
      toToken: 'USDC',
      dex: 'Orca',
      rate: 150.0,
      feeBps: 25,
      liquidityUsd: 1000000,
    });

    // 150 USDC -> 1.02 mSOL on Raydium (1 mSOL = 147.05 USDC => rate = 1/147.05)
    engine.addEdge({
      fromToken: 'USDC',
      toToken: 'mSOL',
      dex: 'Raydium',
      rate: 1 / 147.05,
      feeBps: 25,
      liquidityUsd: 800000,
    });

    // 1 mSOL -> 1.03 SOL on Meteora
    engine.addEdge({
      fromToken: 'mSOL',
      toToken: 'SOL',
      dex: 'Meteora',
      rate: 1.03,
      feeBps: 10,
      liquidityUsd: 500000,
    });

    const arb = engine.findTriangularArbitrage('SOL', 15);
    expect(arb).to.not.be.null;
    expect(arb?.netProfitBps).to.be.greaterThan(15);
    expect(arb?.cycle).to.include('SOL');
  });

  it('should identify profitable spatial DEX spread', () => {
    const scanner = new SpatialArbitrageScanner(15);
    const buyQuote: DexQuote = {
      dexName: 'Orca',
      pair: 'SOL/USDC',
      bidPrice: 149.8,
      askPrice: 150.0,
      availableLiquidityUsd: 50000,
      feeBps: 25,
    };
    const sellQuote: DexQuote = {
      dexName: 'Raydium',
      pair: 'SOL/USDC',
      bidPrice: 151.2,
      askPrice: 151.5,
      availableLiquidityUsd: 50000,
      feeBps: 25,
    };

    const result = scanner.evaluateSpread(buyQuote, sellQuote, 10);
    expect(result.profitable).to.be.true;
    expect(result.netProfitUsd).to.be.greaterThan(0);
  });
});
