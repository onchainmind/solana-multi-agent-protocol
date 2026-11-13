/**
 * Mainnet Pyth oracle supply for the agent.
 *
 * Empirical mainnet state (verified on-chain, 2026-11 — see
 * docs/MAINNET_VERIFICATION.md):
 *  - The classic push-oracle accounts are DECOMMISSIONED (years stale).
 *    This module only speaks the live format.
 *  - The live path is the Pyth RECEIVER program (rec5EKMG…LtFJ): anyone
 *    can post a Wormhole-verified price update into a `PriceUpdateV2`
 *    account (the "pull oracle" pattern). ~4k such accounts exist for
 *    SOL/USD at any moment; only freshly-posted ones are usable, and the
 *    on-chain program independently re-validates owner == configured
 *    receiver, discriminator, feed id, staleness and confidence.
 *
 * Two supply modes, in order of preference:
 *   1. PYTH_SOL_USD_PRICE_ACCOUNT env — an operator-managed account. The
 *      agent verifies ownership, layout and freshness before every crank.
 *   2. AUTO-DISCOVERY: `resolveFreshPythAccount()` scans the receiver
 *      program for accounts carrying the feed id and picks the freshest
 *      (cached for `cacheTtlSecs` — two filtered getProgramAccounts per
 *      TTL, one per verification-level encoding). Works on production
 *      RPC providers; the free public endpoint may throttle this call.
 *
 * To POST your own updates (fully self-sufficient setup): fetch
 *   GET {HERMES_URL}/api/latest_price_updates?ids[]=<feed id>
 * (HERMES_URL default https://hermes.pyth.network) and post the VAA
 * through the Pyth receiver program using the official pyth tooling
 * (pyth-crosschain `solana-agent`, or the Rust `pyth-solana-receiver-sdk`
 * post_update_atomic flow). The on-chain program re-validates whatever
 * account it receives, so a fresh verified account is all it needs.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Pyth Solana Receiver program — the only owner accepted for oracle accounts. */
export const PYTH_RECEIVER_PROGRAM = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
);

/** Anchor discriminator of the PriceUpdateV2 account type. */
export const PRICE_UPDATE_V2_DISC = Buffer.from([
  0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd,
]);

export interface PythPrice {
  /** USD price (human units). */
  usd: number;
  /** publish_time (unix seconds). */
  publishTime: number;
  /** confidence interval in bps of the price (-1 when not parsed). */
  confBps: number;
  /** verification level tag: 1 = Full, 0 = Partial. */
  verification: "Full" | "Partial";
}

/** Parse a PriceUpdateV2 payload (variable verification-level length). */
export function parsePriceUpdateV2(data: Buffer): PythPrice {
  if (
    data.length < 8 + 32 + 1 + 84 + 8 ||
    !data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISC)
  ) {
    throw new Error("not a PriceUpdateV2 account (bad size or discriminator)");
  }
  const variant = data[8 + 32];
  if (variant > 1) throw new Error(`unknown verification level variant ${variant}`);
  const o = 8 + 32 + (variant === 0 ? 2 : 1);
  const price = data.readBigInt64LE(o + 32);
  const conf = data.readBigUInt64LE(o + 40);
  const exponent = data.readInt32LE(o + 48);
  const publishTime = Number(data.readBigInt64LE(o + 52));
  const usd = Number(price) * Math.pow(10, exponent);
  if (!isFinite(usd) || usd <= 0 || publishTime < 1_500_000_000) {
    throw new Error("PriceUpdateV2 payload invalid (price/time)");
  }
  const confBps = Number((conf * 10_000n) / BigInt(Math.max(1, Math.abs(Number(price)))));
  return {
    usd,
    publishTime,
    confBps,
    verification: variant === 1 ? "Full" : "Partial",
  };
}

export class PythOracleResolver {
  private cached?: { account: PublicKey; price: PythPrice; at: number };
  private scanning = false;

  constructor(
    private connection: Connection,
    private feedId: Buffer,
    private maxStalenessSecs: number,
    private cacheTtlSecs = 600
  ) {}

  /** Currently pinned account (env-provided or last discovery). */
  get pinned(): { account: PublicKey; price: PythPrice } | undefined {
    return this.cached
      ? { account: this.cached.account, price: this.cached.price }
      : undefined;
  }

  /**
   * Verify a candidate account: owned by the Pyth receiver program,
   * parses as PriceUpdateV2, carries the right feed, fresh enough.
   * Returns the parsed price, or throws.
   */
  async verify(account: PublicKey): Promise<PythPrice> {
    const info = await this.connection.getAccountInfo(account);
    if (!info) throw new Error(`pyth account ${account.toBase58()} missing`);
    if (!info.owner.equals(PYTH_RECEIVER_PROGRAM)) {
      throw new Error(
        `pyth account ${account.toBase58()} owner ${info.owner.toBase58()} != receiver program`
      );
    }
    const p = parsePriceUpdateV2(Buffer.from(info.data));
    // The parsed message must carry the configured SOL/USD feed id.
    const o = 8 + 32 + (p.verification === "Full" ? 1 : 2);
    if (!Buffer.from(info.data.subarray(o, o + 32)).equals(this.feedId)) {
      throw new Error(
        `pyth account carries a different feed id than configured ` +
          `(expected ${this.feedId.toString("hex").slice(0, 16)}…)`
      );
    }
    const age = Math.floor(Date.now() / 1000) - p.publishTime;
    if (age > this.maxStalenessSecs)
      throw new Error(`pyth account stale: ${age}s > ${this.maxStalenessSecs}s`);
    return p;
  }

  /**
   * Scan the receiver program for the freshest account carrying this
   * feed id. Two filtered getProgramAccounts calls (one per
   * verification-level encoding) — cached for cacheTtlSecs.
   */
  async resolveFresh(): Promise<{ account: PublicKey; price: PythPrice }> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.cacheTtlSecs * 1000) {
      return { account: this.cached.account, price: this.cached.price };
    }
    if (this.scanning) throw new Error("pyth scan already in progress");
    this.scanning = true;
    try {
      // The feed id starts at offset 41 for Full and 42 for Partial
      // (the Partial variant carries one extra borsh byte).
      const feed20 = bs58.encode(this.feedId.subarray(0, 20));
      let best: { account: PublicKey; price: PythPrice; age: number } | null = null;
      for (const offset of [41, 42]) {
        const resp = await this.connection.getProgramAccounts(PYTH_RECEIVER_PROGRAM, {
          filters: [{ memcmp: { offset, bytes: feed20 } }],
          dataSlice: { offset: 0, length: 134 },
          encoding: "base64",
        });
        for (const a of resp) {
          try {
            const p = parsePriceUpdateV2(Buffer.from(a.account.data));
            // Full 32-byte feed id match (memcmp above only checked 20)
            const raw = Buffer.from(a.account.data);
            const o = 8 + 32 + (p.verification === "Full" ? 1 : 2);
            if (!raw.subarray(o, o + 32).equals(this.feedId)) continue;
            const age = Math.floor(Date.now() / 1000) - p.publishTime;
            if (age < 0) continue;
            if (!best || age < best.age) best = { account: a.pubkey, price: p, age };
          } catch {
            // skip malformed slices
          }
        }
      }
      if (!best) throw new Error("no receiver account found for this feed id");
      if (best.age > this.maxStalenessSecs)
        throw new Error(
          `freshest receiver account is ${best.age}s old (> ${this.maxStalenessSecs}s) — ` +
            "post a fresh update (see agent/src/pyth-updater.ts header docs)"
        );
      this.cached = { account: best.account, price: best.price, at: now };
      return { account: best.account, price: best.price };
    } finally {
      this.scanning = false;
    }
  }
}
