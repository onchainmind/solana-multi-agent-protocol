/**
 * Trinity Engine: Cyclic Triangular Arbitrage & Negative Cycle Detection
 * Uses Bellman-Ford algorithm on log-transformed exchange rates:
 * If -log(R_1 * R_2 * ... * R_k) < 0 => (R_1 * R_2 * ... * R_k) > 1.0 (Arbitrage opportunity exists)
 */

export interface TokenEdge {
  fromToken: string;
  toToken: string;
  dex: 'Orca' | 'Raydium' | 'Meteora' | 'Phoenix';
  rate: number; // e.g., 1 SOL = 150 USDC => 150.0
  feeBps: number; // e.g., 25 bps = 0.0025
  liquidityUsd: number;
}

export interface ArbitrageOpportunity {
  cycle: string[]; // e.g. ['SOL', 'USDC', 'mSOL', 'SOL']
  dexes: string[];
  grossReturnMultiplier: number;
  netProfitBps: number;
  recommendedSizeUsd: number;
  estimatedComputeUnits: number;
}

export class GraphArbitrageEngine {
  private tokens: Set<string> = new Set();
  private edges: TokenEdge[] = [];

  constructor() {}

  public addEdge(edge: TokenEdge): void {
    this.tokens.add(edge.fromToken);
    this.tokens.add(edge.toToken);
    this.edges.push(edge);
  }

  public clear(): void {
    this.tokens.clear();
    this.edges = [];
  }

  /**
   * Find cyclic arbitrage opportunities starting and ending at baseToken (e.g. 'SOL' or 'USDC')
   */
  public findTriangularArbitrage(
    baseToken: string,
    minNetProfitBps: number = 15,
    gasFeeLamports: number = 10000
  ): ArbitrageOpportunity | null {
    const tokenList = Array.from(this.tokens);
    const n = tokenList.length;
    if (n < 3) return null;

    const tokenIndex = new Map<string, number>();
    tokenList.forEach((token, idx) => tokenIndex.set(token, idx));

    // Bellman-Ford relaxation on -log(rate * (1 - fee))
    const dist: number[] = new Array(n).fill(Infinity);
    const parent: (number | null)[] = new Array(n).fill(null);
    const edgeUsed: (TokenEdge | null)[] = new Array(n).fill(null);

    const baseIdx = tokenIndex.get(baseToken);
    if (baseIdx === undefined) return null;

    dist[baseIdx] = 0;

    // Relax edges up to n - 1 times
    for (let i = 0; i < n - 1; i++) {
      for (const edge of this.edges) {
        const u = tokenIndex.get(edge.fromToken)!;
        const v = tokenIndex.get(edge.toToken)!;
        const effectiveRate = edge.rate * (1 - edge.feeBps / 10000);
        const weight = -Math.log(effectiveRate);

        if (dist[u] + weight < dist[v]) {
          dist[v] = dist[u] + weight;
          parent[v] = u;
          edgeUsed[v] = edge;
        }
      }
    }

    // Check for negative cycle
    for (const edge of this.edges) {
      const u = tokenIndex.get(edge.fromToken)!;
      const v = tokenIndex.get(edge.toToken)!;
      const effectiveRate = edge.rate * (1 - edge.feeBps / 10000);
      const weight = -Math.log(effectiveRate);

      if (dist[u] + weight < dist[v] - 1e-6) {
        // Trace back the negative cycle
        let curr = v;
        for (let i = 0; i < n; i++) {
          if (parent[curr] !== null) {
            curr = parent[curr]!;
          }
        }

        const cycle: string[] = [];
        const dexes: string[] = [];
        let tracer = curr;
        let cumulativeReturn = 1.0;

        for (let i = 0; i < n; i++) {
          cycle.push(tokenList[tracer]);
          const edge = edgeUsed[tracer];
          if (edge) {
            dexes.push(edge.dex);
            cumulativeReturn *= edge.rate * (1 - edge.feeBps / 10000);
          }
          tracer = parent[tracer]!;
          if (tracer === curr && cycle.length > 2) {
            cycle.push(tokenList[curr]);
            break;
          }
        }

        if (cycle[0] === baseToken && cumulativeReturn > 1.0) {
          const netBps = (cumulativeReturn - 1.0) * 10000;
          if (netBps >= minNetProfitBps) {
            return {
              cycle: cycle.reverse(),
              dexes: dexes.reverse(),
              grossReturnMultiplier: cumulativeReturn,
              netProfitBps: Math.round(netBps),
              recommendedSizeUsd: 5000,
              estimatedComputeUnits: 250000,
            };
          }
        }
      }
    }

    return null;
  }
}
