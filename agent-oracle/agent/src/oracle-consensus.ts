/**
 * Oracle Engine: Multi-Source Oracle Aggregator & Consensus Filter
 * Cross-validates feeds from Pyth Network, Switchboard On-Demand, and Chainlink
 * to eliminate single-point-of-failure oracle exploits and latency arbitrage.
 */

export interface OracleFeedReport {
  source: 'Pyth' | 'Switchboard' | 'Chainlink';
  symbol: string;
  price: number;
  confidence: number;
  publishTime: number; // Unix timestamp
  slot: number;
}

export interface ConsensusPrice {
  symbol: string;
  medianPrice: number;
  divergenceBps: number;
  isValid: boolean;
  status: 'CONSENSUS_HEALTHY' | 'STALE_DATA' | 'DIVERGENCE_ALERT' | 'SINGLE_SOURCE_FALLBACK';
  sourcesUsed: string[];
}

export class MultiSourceOracleAggregator {
  constructor(
    private maxStalenessSeconds: number = 60,
    private maxDivergenceBps: number = 75 // 0.75% max allowable divergence between oracles
  ) {}

  public computeConsensus(feeds: OracleFeedReport[], currentTimestamp: number): ConsensusPrice {
    if (feeds.length === 0) {
      throw new Error('No oracle feed reports provided for consensus calculation.');
    }

    const symbol = feeds[0].symbol;

    // Filter out stale feeds
    const activeFeeds = feeds.filter(
      (f) => currentTimestamp - f.publishTime <= this.maxStalenessSeconds
    );

    if (activeFeeds.length === 0) {
      return {
        symbol,
        medianPrice: 0,
        divergenceBps: 0,
        isValid: false,
        status: 'STALE_DATA',
        sourcesUsed: [],
      };
    }

    if (activeFeeds.length === 1) {
      return {
        symbol,
        medianPrice: activeFeeds[0].price,
        divergenceBps: 0,
        isValid: true,
        status: 'SINGLE_SOURCE_FALLBACK',
        sourcesUsed: [activeFeeds[0].source],
      };
    }

    // Sort prices to compute median
    const sortedPrices = [...activeFeeds].sort((a, b) => a.price - b.price);
    const mid = Math.floor(sortedPrices.length / 2);
    const medianPrice =
      sortedPrices.length % 2 !== 0
        ? sortedPrices[mid].price
        : (sortedPrices[mid - 1].price + sortedPrices[mid].price) / 2;

    const minPrice = sortedPrices[0].price;
    const maxPrice = sortedPrices[sortedPrices.length - 1].price;
    const divergenceBps = Math.round(((maxPrice - minPrice) / medianPrice) * 10000);

    if (divergenceBps > this.maxDivergenceBps) {
      return {
        symbol,
        medianPrice,
        divergenceBps,
        isValid: false,
        status: 'DIVERGENCE_ALERT',
        sourcesUsed: activeFeeds.map((f) => f.source),
      };
    }

    return {
      symbol,
      medianPrice,
      divergenceBps,
      isValid: true,
      status: 'CONSENSUS_HEALTHY',
      sourcesUsed: activeFeeds.map((f) => f.source),
    };
  }
}
