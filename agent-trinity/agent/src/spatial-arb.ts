/**
 * Trinity Engine: Spatial DEX Arbitrage Scanner
 * Identifies two-pool direct price discrepancies across Orca Whirlpools, Raydium, and Meteora
 */

export interface DexQuote {
  dexName: string;
  pair: string;
  bidPrice: number;
  askPrice: number;
  availableLiquidityUsd: number;
  feeBps: number;
}

export interface SpatialArbResult {
  pair: string;
  buyDex: string;
  buyPrice: number;
  sellDex: string;
  sellPrice: number;
  spreadBps: number;
  netProfitUsd: number;
  profitable: boolean;
  maxTradeSizeSol: number;
}

export class SpatialArbitrageScanner {
  constructor(private minProfitThresholdBps: number = 20) {}

  public evaluateSpread(buyQuote: DexQuote, sellQuote: DexQuote, tradeAmountSol: number): SpatialArbResult {
    const buyCost = buyQuote.askPrice * (1 + buyQuote.feeBps / 10000);
    const sellProceeds = sellQuote.bidPrice * (1 - sellQuote.feeBps / 10000);

    const grossSpreadBps = ((sellProceeds - buyCost) / buyCost) * 10000;
    const grossProfitUsd = (sellProceeds - buyCost) * tradeAmountSol;

    // Approximate priority fee + CU costs (~0.0015 SOL equivalent)
    const transactionOverheadUsd = 0.25;
    const netProfitUsd = grossProfitUsd - transactionOverheadUsd;

    return {
      pair: buyQuote.pair,
      buyDex: buyQuote.dexName,
      buyPrice: buyCost,
      sellDex: sellQuote.dexName,
      sellPrice: sellProceeds,
      spreadBps: Math.round(grossSpreadBps),
      netProfitUsd: parseFloat(netProfitUsd.toFixed(2)),
      profitable: grossSpreadBps >= this.minProfitThresholdBps && netProfitUsd > 0,
      maxTradeSizeSol: Math.min(
        tradeAmountSol,
        buyQuote.availableLiquidityUsd / buyCost,
        sellQuote.availableLiquidityUsd / sellProceeds
      ),
    };
  }
}
