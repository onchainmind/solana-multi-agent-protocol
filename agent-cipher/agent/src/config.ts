/**
 * Agent configuration (env-driven — see .env.example).
 *
 * SECURITY CONTROLS:
 *  - Strict integer validation (rejects NaN, floats, negative values, and out-of-range bounds).
 *  - Compute unit limits strictly bounded [10_000, 1_400_000] per Solana transaction constraints.
 *  - URL validation for RPC endpoints (must be valid http/https URL).
 *  - Public key format and base58 validation.
 *  - Pyth feed ID format validation (must be 32 bytes / 64 hex characters).
 *  - Identity key loading with safe error messages (never logs secret key material).
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import { clusterRpc, Cluster, MAINNET, PROGRAM_ID } from "../../sdk/src/config";

/** Default Jupiter Swap API (free tier). Swap API v1 moved here. */
export const DEFAULT_JUP_API_BASE = "https://lite-api.jup.ag/swap/v1";

export interface AgentConfig {
  cluster: Cluster;
  rpcUrl: string;
  wsUrl?: string;
  identity: Keypair;
  programId: PublicKey;
  /** Seconds between scan passes. */
  pollIntervalSecs: number;
  /** Priority fee (micro-lamports per CU) for cranks. */
  priorityFeeMicroLamports: number;
  /** Compute unit limit for crank_trade. */
  crankTradeComputeUnits: number;
  /** Compute unit limit for crank_stake. */
  crankStakeComputeUnits: number;
  /** For trading cranks: a pinned Pyth SOL/USD account (legacy or receiver-v2). */
  pythSolUsdPriceAccount?: PublicKey;
  /** 32-byte SOL/USD feed id for receiver auto-discovery (mainnet default). */
  pythSolUsdFeedId?: Buffer;
  /** Max oracle age the agent tolerates OFF-CHAIN (the program re-checks). */
  pythMaxStalenessSecs: number;
  /**
   * Jupiter Swap API base (mainnet). When set (or when the configured
   * swap program is the real Jupiter v6), trades are routed through
   * agent/src/jupiter-route.ts instead of the localnet mock builder.
   */
  jupiterApiBase?: string;
  /** Slippage (bps) requested from the Jupiter API. */
  jupiterSlippageBps: number;
  /** Optional HTTP healthcheck/metrics port (for OWASP ZAP scanning / orchestrators). */
  healthPort?: number;
  /** Jupiter route builder (mainnet: Jupiter Swap API; tests: mock). */
  routeBuilder?: (
    side: "buy" | "sell",
    amountIn: bigint
  ) => Promise<{
    routeAccounts: PublicKey[];
    routeData: Buffer;
    quotedOutAmount: bigint;
  }>;
}

export function parseCluster(raw?: string): Cluster {
  const cluster = (raw || "localnet").trim();
  if (cluster === "localnet" || cluster === "devnet" || cluster === "mainnet-beta") {
    return cluster as Cluster;
  }
  throw new Error(`Invalid CLUSTER '${raw}'. Allowed: 'localnet' | 'devnet' | 'mainnet-beta'`);
}

export function parseRpcUrl(cluster: Cluster, raw?: string): string {
  if (!raw || raw.trim() === "") {
    return clusterRpc(cluster);
  }
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`RPC_URL must use http or https protocol: ${trimmed}`);
    }
    return trimmed;
  } catch (err: any) {
    throw new Error(`Invalid RPC_URL '${trimmed}': ${err.message}`);
  }
}

export function parseInteger(
  name: string,
  raw: string | undefined,
  defaultVal: number,
  options: { min?: number; max?: number } = {}
): number {
  if (raw === undefined || raw.trim() === "") {
    return defaultVal;
  }
  const trimmed = raw.trim();
  const num = Number(trimmed);
  if (Number.isNaN(num) || !Number.isInteger(num)) {
    throw new Error(`Invalid integer for ${name}: '${raw}'`);
  }
  if (options.min !== undefined && num < options.min) {
    throw new Error(`${name} must be >= ${options.min}, received ${num}`);
  }
  if (options.max !== undefined && num > options.max) {
    throw new Error(`${name} must be <= ${options.max}, received ${num}`);
  }
  return num;
}

export function parsePublicKey(name: string, raw?: string): PublicKey | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  try {
    return new PublicKey(trimmed);
  } catch (err: any) {
    throw new Error(`Invalid PublicKey for ${name} '${trimmed}': ${err.message}`);
  }
}

export function parseFeedId(name: string, raw?: string): Buffer | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(`${name} must be a 64-character hex string (32 bytes), received '${raw}'`);
  }
  return Buffer.from(trimmed, "hex");
}

export function parseIdentityKeypair(env: NodeJS.ProcessEnv): Keypair {
  if (env.AGENT_KEYPAIR_PATH && env.AGENT_KEYPAIR_PATH.trim() !== "") {
    const keyPath = env.AGENT_KEYPAIR_PATH.trim();
    if (!fs.existsSync(keyPath)) {
      throw new Error(`AGENT_KEYPAIR_PATH file does not exist: '${keyPath}'`);
    }
    try {
      const fileData = fs.readFileSync(keyPath, "utf8");
      const parsed = JSON.parse(fileData);
      if (!Array.isArray(parsed) || parsed.length !== 64) {
        throw new Error("Invalid keypair JSON layout (expected 64-byte array)");
      }
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    } catch (err: any) {
      throw new Error(`Failed to load AGENT_KEYPAIR_PATH from '${keyPath}': ${err.message}`);
    }
  } else if (env.AGENT_SECRET_KEY_B58 && env.AGENT_SECRET_KEY_B58.trim() !== "") {
    const b58Str = env.AGENT_SECRET_KEY_B58.trim();
    try {
      const decoded = bs58.decode(b58Str);
      if (decoded.length !== 64) {
        throw new Error("Decoded base58 secret key is not 64 bytes");
      }
      return Keypair.fromSecretKey(decoded);
    } catch (err: any) {
      throw new Error(`Failed to decode AGENT_SECRET_KEY_B58: ${err.message}`);
    }
  } else {
    throw new Error(
      "Missing agent identity: Set AGENT_KEYPAIR_PATH or AGENT_SECRET_KEY_B58 in the environment"
    );
  }
}

export function loadConfigFromEnv(customEnv?: NodeJS.ProcessEnv): AgentConfig {
  const env = customEnv || process.env;
  if (!customEnv) {
    require("dotenv").config();
  }

  const cluster = parseCluster(env.CLUSTER);
  const rpcUrl = parseRpcUrl(cluster, env.RPC_URL);
  const identity = parseIdentityKeypair(env);

  // Safety rail: never let a mainnet deployment silently fall back to the mock route builder
  if (cluster === "mainnet-beta" && env.JUP_API_BASE === "off") {
    throw new Error("JUP_API_BASE=off is strictly prohibited with CLUSTER=mainnet-beta");
  }

  const pythPrice = parsePublicKey("PYTH_SOL_USD_PRICE_ACCOUNT", env.PYTH_SOL_USD_PRICE_ACCOUNT);
  const pythFeedId =
    parseFeedId("PYTH_SOL_USD_FEED_ID", env.PYTH_SOL_USD_FEED_ID) ??
    (cluster === "mainnet-beta" ? Buffer.from(MAINNET.solUsdFeedId) : undefined);

  const pythMaxStaleness = parseInteger(
    "PYTH_MAX_STALENESS_SECS",
    env.PYTH_MAX_STALENESS_SECS,
    30,
    { min: 1, max: 3600 }
  );

  const pollIntervalSecs = parseInteger(
    "POLL_INTERVAL_SECS",
    env.POLL_INTERVAL_SECS,
    30,
    { min: 1, max: 86400 }
  );

  const priorityFeeMicroLamports = parseInteger(
    "PRIORITY_FEE_MICRO_LAMPORTS",
    env.PRIORITY_FEE_MICRO_LAMPORTS,
    100_000,
    { min: 0, max: 100_000_000 }
  );

  const crankTradeComputeUnits = parseInteger(
    "CRANK_TRADE_CU",
    env.CRANK_TRADE_CU,
    400_000,
    { min: 10_000, max: 1_400_000 }
  );

  const crankStakeComputeUnits = parseInteger(
    "CRANK_STAKE_CU",
    env.CRANK_STAKE_CU,
    150_000,
    { min: 10_000, max: 1_400_000 }
  );

  const jupiterSlippageBps = parseInteger(
    "JUP_SLIPPAGE_BPS",
    env.JUP_SLIPPAGE_BPS,
    50,
    { min: 1, max: 10_000 }
  );

  const healthPort = env.AGENT_HEALTH_PORT
    ? parseInteger("AGENT_HEALTH_PORT", env.AGENT_HEALTH_PORT, 8080, { min: 1024, max: 65535 })
    : undefined;

  let jupiterApiBase = env.JUP_API_BASE?.trim();
  if (!jupiterApiBase && cluster === "mainnet-beta") {
    jupiterApiBase = DEFAULT_JUP_API_BASE;
  }
  if (jupiterApiBase && jupiterApiBase !== "off") {
    try {
      new URL(jupiterApiBase);
    } catch (err: any) {
      throw new Error(`Invalid JUP_API_BASE URL '${jupiterApiBase}': ${err.message}`);
    }
  }

  const programId = parsePublicKey("PROGRAM_ID", env.PROGRAM_ID) ?? PROGRAM_ID;

  return {
    cluster,
    rpcUrl,
    identity,
    programId,
    pollIntervalSecs,
    priorityFeeMicroLamports,
    crankTradeComputeUnits,
    crankStakeComputeUnits,
    pythSolUsdPriceAccount: pythPrice,
    pythSolUsdFeedId: pythFeedId,
    pythMaxStalenessSecs: pythMaxStaleness,
    jupiterApiBase,
    jupiterSlippageBps,
    healthPort,
  };
}
