/**
 * PDA derivations and vault account helpers for the cypher program.
 */
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PROGRAM_ID } from "./config";
import { MARINADE_SEEDS } from "./config";

export const CONFIG_SEED = Buffer.from("config", "utf8");
export const POSITION_SEED = Buffer.from("position", "utf8");
export const TIMELOCK_SEED = Buffer.from("timelock", "utf8");

/** Singleton global config PDA. */
export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID)[0];
}

/** User position/vault PDA: ["position", owner]. */
export function positionPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, owner.toBuffer()],
    PROGRAM_ID
  )[0];
}

/** Native-SOL vault PDA: ["vault", owner] (system-owned, no data). */
export function nativeVaultPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault", "utf8"), owner.toBuffer()],
    PROGRAM_ID
  )[0];
}

/** Timelock entry PDA: ["timelock", config, nonce]. */
export function timelockPda(nonce: bigint | number): PublicKey {
  const c = configPda();
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [TIMELOCK_SEED, c.toBuffer(), b],
    PROGRAM_ID
  )[0];
}

/** Vault token accounts (ATAs of the position PDA). */
export function vaultAta(
  position: PublicKey,
  mint: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(mint, position, true, TOKEN_PROGRAM_ID);
}

export function vaultUsdc(position: PublicKey, usdcMint: PublicKey): PublicKey {
  return vaultAta(position, usdcMint);
}
export function vaultWsol(position: PublicKey, wsolMint: PublicKey): PublicKey {
  return vaultAta(position, wsolMint);
}
export function vaultMsol(position: PublicKey, msolMint: PublicKey): PublicKey {
  return vaultAta(position, msolMint);
}

/**
 * Marinade PDA derivations (mirror of the on-chain checks — see
 * programs/cypher/src/cpi/marinade.rs).
 */
export async function marinadePdas(
  marinadeProgram: PublicKey,
  marinadeState: PublicKey
) {
  const derive = (seed: Buffer) =>
    PublicKey.findProgramAddressSync(
      [marinadeState.toBuffer(), seed],
      marinadeProgram
    )[0];
  return {
    liqPoolSolLeg: derive(MARINADE_SEEDS.liqSolLeg),
    liqPoolMsolLegAuthority: derive(MARINADE_SEEDS.liqMsolLegAuthority),
    reservePda: derive(MARINADE_SEEDS.reserve),
    msolMintAuthority: derive(MARINADE_SEEDS.mintAuthority),
    liqPoolMsolLeg: await PublicKey.createWithSeed(
      marinadeState,
      MARINADE_SEEDS.liqMsolLegSeed,
      TOKEN_PROGRAM_ID
    ),
  };
}

/**
 * Jupiter event authority PDA (`["__event_authority"]`) — the program
 * verifies this on-chain for swap CPIs.
 */
export function jupiterEventAuthority(swapProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority", "utf8")],
    swapProgram
  )[0];
}
