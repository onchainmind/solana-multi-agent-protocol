/**
 * Mainnet Jupiter v6 route fetcher.
 *
 * Turns a live Jupiter quote into the exact parts our crank_trade needs:
 *   - routeData: the raw borsh payload AFTER the 8-byte route
 *     discriminator (route_plan + in_amount + quoted_out_amount +
 *     slippage_bps + platform_fee_bps), authored by Jupiter itself —
 *     this module never re-implements the route-plan encoding.
 *   - the named route accounts and the remaining AMM accounts.
 *
 * Every value is cross-checked against what the cypher program will
 * independently enforce on-chain (vault ATAs, dst mint, event authority
 * PDA, program id, platform_fee_bps == 0). Any mismatch throws, so a
 * malformed or hostile API response can never reach the program.
 *
 * Requires `fetch` (Node >= 18) and an RPC endpoint for ALT resolution.
 */
import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

/** sha256("global:route")[..8] — Jupiter v6 `route` discriminator. */
const ROUTE_DISC = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);

export interface RouteParts {
  /** Raw payload after the route discriminator (program appends disc). */
  routeData: Buffer;
  /** v6 destinationTokenAccount slot (dummy = jup program when unused). */
  destinationTokenAccount: PublicKey;
  /** v6 platformFeeAccount slot (dummy when platform_fee_bps == 0). */
  platformFeeAccount: PublicKey;
  /** Remaining AMM accounts (after the 9 fixed route accounts). */
  routeAccounts: PublicKey[];
  /** Quote metadata for logging. */
  outAmount: bigint;
  ammLabel: string;
}

export class JupiterRouteFetcher {
  constructor(
    private apiBase: string, // e.g. https://lite-api.jup.ag/swap/v1
    private connection: Connection,
    private slippageBps: number
  ) {}

  /** Fetch a quote and extract + verify the route instruction parts. */
  async fetchRoute(params: {
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: bigint;
    /** Expected user transfer authority (the position PDA). */
    userPublicKey: PublicKey;
    /** Vault source / destination ATAs — must match Jupiter's choice. */
    srcTa: PublicKey;
    dstTa: PublicKey;
    /** Expected destination mint. */
    dstMint: PublicKey;
    /** Jupiter program id (config.swap_program). */
    jupiterProgram: PublicKey;
  }): Promise<RouteParts> {
    // 1. quote
    const qUrl =
      `${this.apiBase}/quote?inputMint=${params.inputMint.toBase58()}` +
      `&outputMint=${params.outputMint.toBase58()}` +
      `&amount=${params.amountIn.toString()}&slippageBps=${this.slippageBps}` +
      `&restrictIntermediateTokens=true`;
    const qRes = await fetch(qUrl);
    if (!qRes.ok) throw new Error(`jup quote HTTP ${qRes.status}`);
    const quote = (await qRes.json()) as any;
    if (!quote?.routePlan?.length) throw new Error("jup quote: empty route plan");

    // 2. swap — userPublicKey is the POSITION PDA, so every account
    //    Jupiter derives from "the user" is already the right vault.
    const sRes = await fetch(`${this.apiBase}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: params.userPublicKey.toBase58(),
        wrapAndUnwrapSol: false,
        asLegacyTransaction: false, // we parse v0 + ALTs below
      }),
    });
    if (!sRes.ok) throw new Error(`jup swap HTTP ${sRes.status}`);
    const swap = (await sRes.json()) as any;
    if (!swap?.swapTransaction) throw new Error("jup swap: no swapTransaction");

    // 3. decode the transaction and find the route() instruction
    const tx = VersionedTransaction.deserialize(
      Buffer.from(Uint8Array.from(Buffer.from(swap.swapTransaction, "base64")))
    );
    const msg = tx.message;
    const keys: PublicKey[] = [...msg.staticAccountKeys];
    for (const lu of msg.addressTableLookups) {
      const info = await this.connection.getAccountInfo(lu.accountKey);
      if (!info) throw new Error(`cannot resolve ALT ${lu.accountKey.toBase58()}`);
      const table = PublicKeyUtils.deserializeAlt(info.data);
      for (const i of lu.writableIndexes) keys.push(table[i]);
      for (const i of lu.readonlyIndexes) keys.push(table[i]);
    }

    let parts: RouteParts | null = null;
    for (const ix of msg.compiledInstructions) {
      const programId = keys[ix.programIdIndex];
      if (!programId.equals(params.jupiterProgram)) continue;
      // web3.js CompiledInstruction.data is base64 in some versions and
      // raw Uint8Array in others — normalize defensively.
      const raw: unknown = ix.data;
      const data =
        typeof raw === "string"
          ? Buffer.from(raw, "base64")
          : Buffer.from(Array.from(raw as Uint8Array));
      if (!data.subarray(0, 8).equals(ROUTE_DISC)) continue;

      const body = data.subarray(8);
      if (body.length < 19) throw new Error("jup route: payload too short");
      const ixKeys = ix.accountKeyIndexes.map((i) => keys[i]);
      if (ixKeys.length < 9) throw new Error("jup route: too few accounts");

      const named = {
        tokenProgram: ixKeys[0],
        userTransferAuthority: ixKeys[1],
        srcTa: ixKeys[2],
        dstTa: ixKeys[3],
        destinationTokenAccount: ixKeys[4],
        dstMint: ixKeys[5],
        platformFeeAccount: ixKeys[6],
        eventAuthority: ixKeys[7],
        program: ixKeys[8],
      };

      // 4. verify against what the program will enforce on-chain
      const assertEq = (name: string, a: PublicKey, b: PublicKey) => {
        if (!a.equals(b))
          throw new Error(
            `jup route ${name} mismatch: ${a.toBase58()} != ${b.toBase58()}`
          );
      };
      assertEq("userTransferAuthority", named.userTransferAuthority, params.userPublicKey);
      assertEq("userSourceTokenAccount", named.srcTa, params.srcTa);
      assertEq("userDestinationTokenAccount", named.dstTa, params.dstTa);
      assertEq("destinationMint", named.dstMint, params.dstMint);
      assertEq("program", named.program, params.jupiterProgram);
      const expectedEventAuth = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        params.jupiterProgram
      )[0];
      assertEq("eventAuthority", named.eventAuthority, expectedEventAuth);
      if (body[body.length - 1] !== 0)
        throw new Error("jup route: platform_fee_bps != 0 (rejected on-chain)");

      parts = {
        routeData: Buffer.from(body), // copy out of the subarray view
        destinationTokenAccount: named.destinationTokenAccount,
        platformFeeAccount: named.platformFeeAccount,
        routeAccounts: ixKeys.slice(9),
        outAmount: BigInt(quote.outAmount ?? 0),
        ammLabel: quote.routePlan
          .map((s: any) => s.swapInfo?.label ?? "?")
          .join("->"),
      };
      break;
    }
    if (!parts) throw new Error("jup swap tx contained no route() instruction");
    return parts;
  }
}

/**
 * ALT data deserialization — matches @solana/web3.js
 * AddressLookupTableAccount.deserialize: fixed 56-byte metadata header
 * (4-byte disc + meta), then raw Pubkeys to the end of the account.
 */
const LOOKUP_TABLE_META_SIZE = 56;
const PublicKeyUtils = {
  deserializeAlt(data: Buffer): PublicKey[] {
    if (data.length < LOOKUP_TABLE_META_SIZE)
      throw new Error("ALT data too short");
    const body = data.length - LOOKUP_TABLE_META_SIZE;
    const n = Math.floor(body / 32);
    const out: PublicKey[] = [];
    for (let i = 0; i < n; i++)
      out.push(
        new PublicKey(
          data.subarray(LOOKUP_TABLE_META_SIZE + i * 32, LOOKUP_TABLE_META_SIZE + (i + 1) * 32)
        )
      );
    return out;
  },
};
