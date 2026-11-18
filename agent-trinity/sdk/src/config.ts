/**
 * Network configuration and verified protocol addresses.
 *
 * IMPORTANT: the mainnet addresses below were verified on 2026-11 from
 * primary sources AND from the chain itself:
 *  - Marinade program / state / mSOL mint: official
 *    @marinade.finance/marinade-ts-sdk (dist/src/config/marinade-config.js)
 *    — marinadeFinanceProgramId + marinadeStateAddress.
 *  - deposit / liquidUnstake account order + mutability: the official
 *    Marinade IDL shipped in the same SDK
 *    (dist/src/programs/idl/types/marinade_finance.js), discriminators
 *    recomputed as sha256("global:...")[..8]. See docs/MAINNET_VERIFICATION.md.
 *  - Liq-pool PDAs: re-derived from seeds + confirmed on-chain
 *    (reserve holds the staked SOL, mSOL mint authority == st_mint PDA,
 *    liq-pool mSOL leg == create_with_seed(state, "liq_st_sol", Token)).
 *  - Marinade treasury mSOL account: read from the on-chain State account
 *    at byte offset 104 (after the 8-byte Anchor discriminator).
 *  - Jupiter v6 program: https://github.com/jup-ag/jupiter-cpi (declare_id);
 *    on-chain check confirms the deployed program is IMMUTABLE
 *    (no upgrade authority).
 *  - Pyth SOL/USD feed id: https://docs.pyth.network/price-feed-ids
 *    The live oracle account format is the receiver PriceUpdateV2
 *    (pull oracle) — receiver program id taken from the official
 *    pyth-solana-receiver-sdk crate (lib.rs declare_id).
 *  - USDC / WSOL mints: well-known SPL token registry entries
 *
 * ALWAYS re-verify before configuring a mainnet deployment: run
 *   npm run preflight
 */
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "26RUtGoZz6Nptsf3p1fwK48ydu4PNQ2FenJGNhHqrXMC"
);
export const MOCK_MARINADE_PROGRAM_ID = new PublicKey(
  "1XBRVR4Y193YUggzVBFLxmBZhi7ksqUXtPX1nv5L4Ju"
);
export const MOCK_JUPITER_PROGRAM_ID = new PublicKey(
  "DdKcq1Rm82gJGAZuQLR3wBF2VESdp4FvVmkooD5uFbcG"
);

/** Well-known mainnet addresses. */
export const MAINNET = {
  marinadeProgram: new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD"),
  marinadeState: new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC"),
  msolMint: new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
  /** Marinade reserve PDA [state, "reserve"] — holds the staked SOL. */
  marinadeReserve: new PublicKey("Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN"),
  /** Liq-pool SOL leg PDA [state, "liq_sol"]. */
  marinadeLiqSolLeg: new PublicKey("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q"),
  /** Liq-pool mSOL leg: create_with_seed(state, "liq_st_sol", Token). */
  marinadeLiqMsolLeg: new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE"),
  /** Liq-pool mSOL leg authority PDA [state, "liq_st_sol_authority"]. */
  marinadeLiqMsolLegAuthority: new PublicKey(
    "EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL"
  ),
  /** mSOL mint authority PDA [state, "st_mint"] (== mSOL mint authority). */
  msolMintAuthority: new PublicKey("3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM"),
  /** Marinade treasury mSOL token account (receives the unstake fee). */
  msolTreasury: new PublicKey("B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR"),
  jupiterV6: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
  /** Pyth Solana Receiver program (owns PriceUpdateV2 oracle accounts). */
  pythReceiver: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
  usdcMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  wsolMint: new PublicKey("So11111111111111111111111111111111111111112"),
  /** Pyth SOL/USD feed id (32 bytes). */
  solUsdFeedId: Buffer.from(
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    "hex"
  ),
} as const;

/**
 * Marinade liq-pool PDA seeds — verified against marinade-finance source
 * (programs/marinade-finance/src/state.rs and state/liq_pool.rs).
 */
export const MARINADE_SEEDS = {
  reserve: Buffer.from("reserve", "utf8"),
  mintAuthority: Buffer.from("st_mint", "utf8"),
  liqSolLeg: Buffer.from("liq_sol", "utf8"),
  liqMsolLegAuthority: Buffer.from("liq_st_sol_authority", "utf8"),
  liqMsolLegSeed: "liq_st_sol",
} as const;

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const USDC_DECIMALS = 6;

/**
 * Re-derive every Marinade side account from the seeds and check it
 * matches the constants above. Pure CPU (no RPC) except the final
 * create_with_seed check. Returns the list of mismatches (empty = all
 * good). Run this before any mainnet init.
 */
export async function verifyMainnetDerivations(): Promise<string[]> {
  const problems: string[] = [];
  const state = MAINNET.marinadeState;
  const program = MAINNET.marinadeProgram;
  const token = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const find = (seeds: Buffer[]) =>
    PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  const withSeed = (
    await PublicKey.createWithSeed(
      state,
      MARINADE_SEEDS.liqMsolLegSeed,
      token
    )
  ).toBase58();

  const expect = (name: string, derived: string, known: string) => {
    if (derived !== known)
      problems.push(`${name}: derived ${derived} != known ${known}`);
  };
  expect("reserve", find([state.toBuffer(), MARINADE_SEEDS.reserve]),
    MAINNET.marinadeReserve.toBase58());
  expect("st_mint authority", find([state.toBuffer(), MARINADE_SEEDS.mintAuthority]),
    MAINNET.msolMintAuthority.toBase58());
  expect("liq_sol leg", find([state.toBuffer(), MARINADE_SEEDS.liqSolLeg]),
    MAINNET.marinadeLiqSolLeg.toBase58());
  expect("liq_st_sol_authority", find([state.toBuffer(), MARINADE_SEEDS.liqMsolLegAuthority]),
    MAINNET.marinadeLiqMsolLegAuthority.toBase58());
  expect("liq_st_sol leg", withSeed,
    MAINNET.marinadeLiqMsolLeg.toBase58());
  return problems;
}

/** Default devnet/localnet risk bounds used by scripts/setup-config.ts. */
export const DEFAULT_RISK = {
  maxPriceStalenessSecs: 60,
  maxPriceConfBps: 100, // 1% confidence bound
  maxSlippageBps: 200, // 2% hard cap
  minDepositLamports: 50_000_000, // 0.05 SOL
  maxDepositLamports: 100 * LAMPORTS_PER_SOL,
  maxTradeUsdc: 10_000 * 1_000_000, // 10,000 USDC
  minStakeLamports: 100_000_000, // 0.1 SOL
  minReserveLamports: 20_000_000, // ~0.02 SOL (rent + buffer)
  timelockDelaySecs: 86_400, // 24h on mainnet; scripts may lower it on devnet
} as const;

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

export function clusterRpc(cluster: Cluster, rpcOverride?: string): string {
  if (rpcOverride) return rpcOverride;
  switch (cluster) {
    case "localnet":
      return "http://127.0.0.1:8899";
    case "devnet":
      return "https://api.devnet.solana.com";
    case "mainnet-beta":
      return "https://api.mainnet-beta.solana.com";
  }
}
