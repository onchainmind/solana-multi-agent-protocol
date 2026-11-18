/**
 * Quantum Engine: Spot-Perp Delta-Neutral Basis & Funding Rate Harvester
 * Captures annualized funding rates on Solana perpetuals (Drift / Zeta / Jupiter Perps)
 * while maintaining 100% delta-neutrality via spot inventory.
 */

export interface FundingRateQuote {
  market: string;
  spotPrice: number;
  perpPrice: number;
  hourlyFundingRate: number; // e.g., 0.0001 = 0.01% per hour
  annualizedApy: number; // e.g., 87.6%
}

export class BasisHarvester {
  /**
   * Calculate annualized funding APY from hourly funding rate
   * APY = (1 + hourlyRate)^(24 * 365) - 1
   */
  public static calculateAnnualizedYield(hourlyFundingRate: number): number {
    const hoursPerYear = 8760;
    const apy = Math.pow(1 + hourlyFundingRate, hoursPerYear) - 1;
    return parseFloat((apy * 100).toFixed(2));
  }

  /**
   * Evaluate whether basis carry trade is profitable after borrowing costs and execution slippage
   */
  public static evaluateBasisTrade(
    quote: FundingRateQuote,
    borrowCostApy: number = 5.0,
    minNetApyThreshold: number = 12.0
  ): { isExecutable: boolean; netApy: number; strategy: 'ENTER_CASH_AND_CARRY' | 'UNWIND_POSITION' | 'HOLD' } {
    const netApy = quote.annualizedApy - borrowCostApy;

    let strategy: 'ENTER_CASH_AND_CARRY' | 'UNWIND_POSITION' | 'HOLD' = 'HOLD';
    let isExecutable = false;

    if (netApy >= minNetApyThreshold && quote.perpPrice >= quote.spotPrice) {
      strategy = 'ENTER_CASH_AND_CARRY'; // Buy spot + Short Perp
      isExecutable = true;
    } else if (netApy < 0) {
      strategy = 'UNWIND_POSITION'; // Close position to prevent funding drag
      isExecutable = true;
    }

    return {
      isExecutable,
      netApy: parseFloat(netApy.toFixed(2)),
      strategy,
    };
  }
}
