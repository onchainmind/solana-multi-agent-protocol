#!/usr/bin/env ts-node
/**
 * Cypher agent — the "autonomous" execution layer.
 *
 * Solana programs cannot wake themselves up. This service watches all
 * active positions and submits the program's permissionless cranks when
 * they are due. It is intentionally DUMB:
 *
 *  - It cannot choose amounts, prices or mints (all decided on-chain).
 *  - It cannot touch user funds (no user signature exists here; a crank
 *    transaction contains only the agent's fee-payer signature).
 *  - If it stops, user funds just sit in their vaults — nothing is lost,
 *    nothing is liquidatable, and any other party can run the same crank.
 *
 * For each position the agent:
 *   1. reads the global config (skip everything if globally paused),
 *   2. scans positions via getProgramAccounts filters
 *      (active == 1, paused == 0),
 *   3. for staking positions: sends crank_stake when the cooldown has
 *      passed and idle SOL exists,
 *   4. for trading positions: checks DCA timing / price triggers OFF-CHAIN
 *      (cheap pre-filter only — the program re-checks everything), fetches
 *      a Jupiter quote, and sends crank_trade.
 */
import {
  Connection,
  PublicKey,
  SendOptions,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import {
  CypherClient,
  encodeRouteData,
  loadIdl,
  positionPda,
  configPda,
  nativeVaultPda,
  MAINNET,
} from "../../sdk/src";
import { loadConfigFromEnv, AgentConfig } from "./config";
import { JupiterRouteFetcher } from "./jupiter-route";
import { PythOracleResolver } from "./pyth-updater";
import { startHealthServer } from "./health";

const POSITION_DISCRIMINATOR_LEN = 8;
// Anchor borsh layout offsets inside UserPosition (discriminator 8 bytes):
// owner 32 | strategy 1 | active 1 | paused 1 | params(24)
const OFF_OWNER = 8;
const OFF_STRATEGY = OFF_OWNER + 32;
const OFF_ACTIVE = OFF_STRATEGY + 1;
const OFF_PAUSED = OFF_ACTIVE + 1;

class Agent {
  private cfg: AgentConfig;
  private client: CypherClient;
  private connection: Connection;
  private running = true;
  private startTime = Date.now();
  private lastTickTimestamp?: number;
  private jupFetcher?: JupiterRouteFetcher;
  private pyth?: PythOracleResolver;
  private pythFeedId?: Buffer;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.connection = new Connection(cfg.rpcUrl, "confirmed");
    const provider = new AnchorProvider(
      this.connection,
      new Wallet(cfg.identity),
      { commitment: "confirmed" }
    );
    this.client = new CypherClient(provider, loadIdl());
    if (cfg.jupiterApiBase) {
      this.jupFetcher = new JupiterRouteFetcher(
        cfg.jupiterApiBase,
        this.connection,
        cfg.jupiterSlippageBps
      );
      console.log(`[agent] jupiter api: ${cfg.jupiterApiBase}`);
    } else {
      console.log("[agent] jupiter api DISABLED (mock route builder only)");
    }
    if (cfg.pythSolUsdPriceAccount) {
      // Pinned-account mode: the resolver verifies ownership, layout,
      // feed id and freshness of the pinned account on every use.
      const feedId =
        cfg.pythSolUsdFeedId ?? Buffer.from(MAINNET.solUsdFeedId);
      this.pyth = new PythOracleResolver(
        this.connection,
        feedId,
        cfg.pythMaxStalenessSecs
      );
      this.pythFeedId = feedId;
      console.log(`[agent] pyth account: ${cfg.pythSolUsdPriceAccount.toBase58()}`);
    } else if (cfg.pythSolUsdFeedId) {
      // Auto-discovery mode (mainnet default): scan the receiver program
      // for the freshest account carrying this feed id.
      this.pythFeedId = cfg.pythSolUsdFeedId;
      this.pyth = new PythOracleResolver(
        this.connection,
        cfg.pythSolUsdFeedId,
        cfg.pythMaxStalenessSecs
      );
      console.log("[agent] pyth: auto-discovery mode (receiver scan, cached)");
    }
  }

  /**
   * Get a fresh-enough oracle account + price for trading, or null when
   * no usable oracle is available (the program would reject it anyway).
   */
  private async getOracle(): Promise<
    { account: PublicKey; priceUsd: number } | null
  > {
    if (!this.pyth) return null;
    try {
      if (this.cfg.pythSolUsdPriceAccount) {
        // Pinned mode: verify freshness on every use (cheap read).
        const price = await this.pyth.verify(this.cfg.pythSolUsdPriceAccount);
        return { account: this.cfg.pythSolUsdPriceAccount, priceUsd: price.usd };
      }
      const { account, price } = await this.pyth.resolveFresh();
      return { account, priceUsd: price.usd };
    } catch (e: any) {
      console.error(`[agent] pyth oracle unavailable: ${e?.message ?? e}`);
      return null;
    }
  }

  async start() {
    console.log(`[agent] identity: ${this.cfg.identity.publicKey.toBase58()}`);
    console.log(`[agent] program:  ${this.cfg.programId.toBase58()}`);
    console.log(`[agent] cluster:  ${this.cfg.cluster} (${this.cfg.rpcUrl})`);
    if (this.cfg.healthPort) {
      startHealthServer({
        port: this.cfg.healthPort,
        getStatus: () => ({
          healthy: this.running,
          uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
          cluster: this.cfg.cluster,
          lastTickTimestamp: this.lastTickTimestamp,
        }),
      });
    }
    while (this.running) {
      try {
        await this.tick();
      } catch (e: any) {
        console.error(`[agent] tick error: ${e?.message ?? e}`);
      }
      await sleep(this.cfg.pollIntervalSecs * 1000);
    }
  }

  private async tick() {
    this.lastTickTimestamp = Date.now();
    // 1. Global pause check — single read.
    const config = await (this.client.program.account as any).globalConfig.fetch(configPda());
    if (config.paused) {
      console.log("[agent] protocol globally paused; standing by");
      return;
    }

    // 2. Scan positions: active == true, paused == false (memcmp filters).
    const positions = await (this.client.program.account as any).userPosition.all([
      { memcmp: { offset: OFF_ACTIVE, bytes: bs58One() } },
      { memcmp: { offset: OFF_PAUSED, bytes: bs58Zero() } },
    ]);

    for (const { account, publicKey } of positions) {
      try {
        await this.handlePosition(publicKey, account, config);
      } catch (e: any) {
        console.error(`[agent] ${publicKey.toBase58()}: ${e?.message ?? e}`);
      }
    }
  }

  private async handlePosition(positionKey: PublicKey, pos: any, config: any) {
    const owner = pos.owner as PublicKey;
    const strategy = Number(pos.strategy);
    if (!pos.active || pos.paused) return;

    const now = Math.floor(Date.now() / 1000);

    if (strategy === 1) {
      // ---- Staking: cooldown + idle SOL above reserve --------------------
      const last = Number(pos.lastStakeTs);
      const cooldown = Number(pos.params.cycleSecs ?? 60);
      if (last !== 0 && now < last + cooldown) return;
      const balance = await this.connection.getBalance(nativeVaultPda(owner));
      const reserve = Number(config.minReserveLamports);
      const minStake = Number(config.minStakeLamports);
      if (balance - reserve < minStake) return;

      const tx = await this.client.crankStake(owner, {
        computeUnits: this.cfg.crankStakeComputeUnits,
        priorityFeeMicroLamports: this.cfg.priorityFeeMicroLamports,
      });
      const sig = await this.send(tx);
      console.log(`[agent] crank_stake ${owner.toBase58()} -> ${sig}`);
      return;
    }

    if (strategy === 2) {
      // ---- Trading: cheap off-chain pre-filter, on-chain decides ---------
      const oracle = await this.getOracle();
      if (!oracle) {
        console.error("[agent] no usable Pyth oracle; skipping trading cranks");
        return;
      }
      const pythPriceAccount = oracle.account;
      const wsolHeld = Number(pos.positionSolAmount) > 0;
      const due = now >= Number(pos.nextDcaAt);

      if (!wsolHeld) {
        if (!due) return;
        const usdcAta = getAssociatedTokenAddressSync(
          config.usdcMint,
          positionKey,
          true
        );
        let usdcBal = 0n;
        try {
          usdcBal = (await getAccount(this.connection, usdcAta)).amount;
        } catch {
          return;
        }
        if (usdcBal < BigInt(pos.params.tradeAmountUsdc.toString())) return;
      }
      // While holding, let the program decide via the oracle every pass —
      // it emits NothingToDo (cheap success) if no trigger fired.

      const p = positionPda(owner);
      const srcTa = getAssociatedTokenAddressSync(
        wsolHeld ? config.wsolMint : config.usdcMint,
        p,
        true
      );
      const dstTa = getAssociatedTokenAddressSync(
        wsolHeld ? config.usdcMint : config.wsolMint,
        p,
        true
      );
      const dstMint = wsolHeld ? config.usdcMint : config.wsolMint;

      const price = Math.round(oracle.priceUsd * 1e6); // canonical 6dp
      const {
        routeAccounts,
        routeData,
        destinationTokenAccount,
        platformFeeAccount,
      } = await this.buildRoute(
        wsolHeld ? "sell" : "buy",
        wsolHeld ? BigInt(pos.positionSolAmount.toString()) : BigInt(pos.params.tradeAmountUsdc.toString()),
        price,
        {
          position: p,
          srcTa,
          dstTa,
          dstMint,
          inputMint: wsolHeld ? config.wsolMint : config.usdcMint,
          jupiterProgram: config.swapProgram,
        }
      );

      const tx = await this.client.crankTrade(
        owner,
        pythPriceAccount,
        {
          srcTa,
          dstTa,
          destinationTokenAccount: destinationTokenAccount ?? config.swapProgram,
          dstMint,
          platformFeeAccount: platformFeeAccount ?? config.swapProgram,
          routeAccounts,
        },
        routeData,
        {
          computeUnits: this.cfg.crankTradeComputeUnits,
          priorityFeeMicroLamports: this.cfg.priorityFeeMicroLamports,
        }
      );
      const sig = await this.send(tx);
      console.log(
        `[agent] crank_trade ${owner.toBase58()} (${wsolHeld ? "sell" : "buy"}) -> ${sig}`
      );
      return;
    }
  }

  /**
   * Build a Jupiter route.
   *
   * Mainnet: fetch a live quote from the Jupiter Swap API, take the
   * route() instruction Jupiter authored for OUR position PDA, verify
   * every account/payload byte against the program's on-chain rules,
   * and hand the parts to crank_trade (agent/src/jupiter-route.ts).
   * Localnet/tests: fall back to the exact-in mock payload (the mock
   * program fills at its own fixed price; the program still enforces
   * the oracle-anchored min-output on-chain).
   */
  private async buildRoute(
    side: "buy" | "sell",
    amountIn: bigint,
    oraclePrice6dp: number,
    ctxAccounts: {
      position: PublicKey;
      srcTa: PublicKey;
      dstTa: PublicKey;
      dstMint: PublicKey;
      inputMint: PublicKey;
      jupiterProgram: PublicKey;
    }
  ): Promise<{
    routeAccounts: PublicKey[];
    routeData: Buffer;
    destinationTokenAccount?: PublicKey;
    platformFeeAccount?: PublicKey;
  }> {
    if (this.cfg.routeBuilder) {
      const r = await this.cfg.routeBuilder(side, amountIn);
      return { routeAccounts: r.routeAccounts, routeData: r.routeData };
    }
    if (this.jupFetcher) {
      const parts = await this.jupFetcher.fetchRoute({
        inputMint: ctxAccounts.inputMint,
        outputMint: ctxAccounts.dstMint,
        amountIn,
        userPublicKey: ctxAccounts.position,
        srcTa: ctxAccounts.srcTa,
        dstTa: ctxAccounts.dstTa,
        dstMint: ctxAccounts.dstMint,
        jupiterProgram: ctxAccounts.jupiterProgram,
      });
      console.log(
        `[agent] jup route ${side} via ${parts.ammLabel}, quoted out ${parts.outAmount}`
      );
      return {
        routeAccounts: parts.routeAccounts,
        routeData: parts.routeData,
        destinationTokenAccount: parts.destinationTokenAccount,
        platformFeeAccount: parts.platformFeeAccount,
      };
    }
    // Mock/default: expected out from the oracle for logging only.
    const expectedOut =
      side === "buy"
        ? (amountIn * 1_000_000_000n) / BigInt(Math.round(oraclePrice6dp))
        : (amountIn * BigInt(Math.round(oraclePrice6dp))) / 1_000_000_000n;
    return {
      routeAccounts: [],
      routeData: encodeRouteData(amountIn, expectedOut, 0, 0),
    };
  }

  private async send(tx: Transaction): Promise<string> {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.cfg.identity.publicKey;
    tx.sign(this.cfg.identity);

    // Preflight Simulation: verify execution succeeds prior to broadcast
    try {
      const sim = await this.connection.simulateTransaction(tx);
      if (sim.value.err) {
        throw new Error(
          `Transaction simulation failed: ${JSON.stringify(sim.value.err)}`
        );
      }
    } catch (simErr: any) {
      console.warn(`[agent] simulation warning: ${simErr?.message ?? simErr}`);
      throw simErr;
    }

    const raw = tx.serialize();
    const opts: SendOptions = { skipPreflight: false, maxRetries: 3 };
    const sig = await this.connection.sendRawTransaction(raw, opts);
    await this.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    return sig;
  }
}

function bs58One(): string {
  // base58 of [1]
  return "2";
}
function bs58Zero(): string {
  // base58 of [0]
  return "1";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const POSITION_SPACE = 140;

// keep the unused imports referenced for documentation value
void POSITION_DISCRIMINATOR_LEN;
void POSITION_SPACE;
void BN;

const cfg = loadConfigFromEnv();
new Agent(cfg).start().catch((e) => {
  console.error("[agent] fatal:", e);
  process.exit(1);
});
