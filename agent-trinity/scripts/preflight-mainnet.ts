#!/usr/bin/env ts-node
/**
 * Mainnet preflight — run BEFORE `initialize-config --cluster mainnet-beta`.
 *
 * Verifies every external dependency the protocol will touch, from the
 * chain itself (not from docs):
 *   1. Marinade PDAs re-derived from seeds match the audited constants.
 *   2. mSOL mint authority == the st_mint PDA (correct SPL offsets).
 *   3. Reserve PDA exists, is system-owned and holds the staked SOL.
 *   4. Liq-pool mSOL leg is a token account of the right mint.
 *   5. Treasury mSOL account is a token account of the right mint.
 *   6. Marinade + Jupiter v6 + Pyth receiver programs are deployed
 *      (executable). Jupiter's upgrade authority is REPORTED
 *      (verified immutable on 2026-11 — re-checked every run).
 *   7. A FRESH Pyth SOL/USD PriceUpdateV2 receiver account exists on
 *      chain right now and parses with the SAME layout the on-chain
 *      parser expects (owner == receiver program, discriminator,
 *      feed id, price sanity, staleness).
 *   8. USDC / WSOL mints exist with the expected decimals.
 *
 * Exit code 0 = safe to initialize. Any check failing = DO NOT DEPLOY.
 *
 * Usage:
 *   npm run preflight            (or: ts-node scripts/preflight-mainnet.ts [--rpc <url>])
 */
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { clusterRpc, MAINNET, verifyMainnetDerivations } from "../sdk/src/config";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Anchor discriminator of the PriceUpdateV2 account type. */
const PU_V2_DISC = Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);

const args = process.argv.slice(2);
const rpcArg = args.includes("--rpc") ? args[args.indexOf("--rpc") + 1] : undefined;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}

/** Parse a PriceUpdateV2 payload with variable verification-level length. */
function parsePriceUpdateV2(data: Buffer):
  | { feedId: Buffer; price: bigint; conf: bigint; exponent: number; publishTime: bigint }
  | null {
  if (data.length < 8 + 32 + 1 + 84 + 8) return null;
  if (!data.subarray(0, 8).equals(PU_V2_DISC)) return null;
  const variant = data[8 + 32];
  if (variant > 1) return null;
  const o = 8 + 32 + (variant === 0 ? 2 : 1);
  const feedId = data.subarray(o, o + 32);
  const price = data.readBigInt64LE(o + 32);
  const conf = data.readBigUInt64LE(o + 40);
  const exponent = data.readInt32LE(o + 48);
  const publishTime = data.readBigInt64LE(o + 52);
  return { feedId, price, conf, exponent, publishTime };
}

async function main() {
  const rpc = clusterRpc("mainnet-beta", rpcArg);
  const conn = new Connection(rpc, "confirmed");
  console.log(`preflight against ${rpc}\n`);

  // 1. PDA re-derivation (CPU only)
  const problems = await verifyMainnetDerivations();
  check(
    "marinade PDA re-derivation matches audited constants",
    problems.length === 0,
    problems.join("; ")
  );

  const info = async (k: PublicKey) => conn.getAccountInfo(k);

  // 2. mSOL mint authority + decimals (SPL Mint layout:
  //    COption<authority> at 0..36, rent_epoch 36..44, supply 44..52,
  //    decimals at 44).
  const msol = await info(MAINNET.msolMint);
  if (msol) {
    const hasAuth = msol.data.readUInt32LE(0) === 1;
    const auth = hasAuth ? new PublicKey(msol.data.subarray(4, 36)) : null;
    check(
      "mSOL mint authority == st_mint PDA",
      auth?.equals(MAINNET.msolMintAuthority) ?? false,
      auth?.toBase58()
    );
    check("mSOL mint decimals == 9", msol.data[44] === 9, `got ${msol.data[44]}`);
  } else check("mSOL mint exists", false);

  // 3. reserve PDA
  const reserve = await info(MAINNET.marinadeReserve);
  check(
    "reserve PDA exists, system-owned, holds SOL",
    !!reserve &&
      reserve.owner.equals(new PublicKey("11111111111111111111111111111111")) &&
      reserve.lamports > 0,
    reserve ? `${(reserve.lamports / 1e9).toFixed(2)} SOL` : "missing"
  );

  // 4. liq-pool mSOL leg
  const leg = await info(MAINNET.marinadeLiqMsolLeg);
  check(
    "liq-pool mSOL leg is a token account of mSOL",
    !!leg && leg.owner.equals(TOKEN_PROGRAM) && leg.data.subarray(0, 32).equals(MAINNET.msolMint.toBuffer()),
    leg ? undefined : "missing"
  );

  // 5. treasury mSOL account
  const treas = await info(MAINNET.msolTreasury);
  check(
    "treasury account is an mSOL token account",
    !!treas && treas.owner.equals(TOKEN_PROGRAM) && treas.data.subarray(0, 32).equals(MAINNET.msolMint.toBuffer()),
    treas ? undefined : "missing"
  );

  // 6. programs deployed + executable (+ upgrade-authority report)
  for (const [name, key] of [
    ["Marinade program", MAINNET.marinadeProgram],
    ["Jupiter v6 program", MAINNET.jupiterV6],
    ["Pyth receiver program", MAINNET.pythReceiver],
  ] as [string, PublicKey][]) {
    const p = await info(key);
    check(`${name} deployed + executable`, !!p && p.executable);
  }

  try {
    const jup = await info(MAINNET.jupiterV6);
    if (jup && jup.owner.equals(BPF_UPGRADEABLE) && jup.data.length >= 36) {
      const progdata = new PublicKey(jup.data.subarray(4, 36));
      const pd = await info(progdata);
      if (pd && pd.data.length >= 45) {
        // ProgramData layout: enum(4) + slot(8) + COption<authority>(4+32)
        const hasAuth = pd.data.readUInt32LE(12) === 1;
        const auth = hasAuth ? new PublicKey(pd.data.subarray(16, 48)) : null;
        console.log(
          `[INFO] Jupiter v6 upgrade authority: ${
            auth ? auth.toBase58() + " (UPGRADEABLE)" : "NONE — program is IMMUTABLE"
          }`
        );
        if (auth) console.log("[WARN] Jupiter became upgradeable — re-evaluate before trading");
      }
    }
  } catch {
    console.log("[INFO] could not read Jupiter programdata (non-fatal)");
  }

  // 7. Pyth SOL/USD: find a FRESH receiver PriceUpdateV2 account on chain.
  //    Receiver accounts have no canonical address; the on-chain program
  //    accepts any account owned by config.pyth_receiver_program whose
  //    embedded feed id / staleness / confidence pass validation.
  const feedBytes = Buffer.from(MAINNET.solUsdFeedId);
  let found:
    | { pubkey: PublicKey; price: bigint; conf: bigint; exponent: number; publishTime: bigint }
    | null = null;
  try {
    // The feed id sits at offset 41 (Full) or 42 (Partial{...}); two
    // filtered scans cover both verification-level encodings.
    for (const offset of [41, 42]) {
      const resp = await conn.getProgramAccounts(MAINNET.pythReceiver, {
        filters: [
          { memcmp: { offset, bytes: bs58.encode(feedBytes.subarray(0, 20)) } },
        ],
        dataSlice: { offset: 0, length: 134 },
        encoding: "base64",
      });
      const now = Math.floor(Date.now() / 1000);
      for (const a of resp) {
        const p = parsePriceUpdateV2(Buffer.from(a.account.data));
        if (!p || !p.feedId.equals(feedBytes)) continue;
        const age = now - Number(p.publishTime);
        if (age < 0 || age > 60) continue;
        if (!found) found = { pubkey: a.pubkey, ...p };
      }
      if (found) break;
    }
  } catch (e) {
    console.log(`[INFO] receiver scan unavailable on this RPC (${String(e).slice(0, 120)})`);
  }

  if (found) {
    const age = Math.floor(Date.now() / 1000) - Number(found.publishTime);
    const usd = Number(found.price) * Math.pow(10, found.exponent);
    const confBps = Number((found.conf * 10_000n) / BigInt(Math.max(1, Math.abs(Number(found.price)))));
    check("pyth SOL/USD receiver account found", true, found.pubkey.toBase58());
    check("pyth SOL/USD price sane", usd > 1 && usd < 1_000_000, `$${usd.toFixed(2)}`);
    check("pyth SOL/USD fresh (< 60s)", age >= 0 && age < 60, `${age}s old`);
    check(
      "pyth confidence inside the 1% default bound",
      confBps <= 100,
      `~${confBps} bps`
    );
    console.log(
      "[INFO] agents must supply a fresh receiver account per crank " +
        "(agent auto-discovery does this) — see agent/src/pyth-updater.ts"
    );
  } else {
    check(
      "fresh pyth SOL/USD receiver account exists",
      false,
      "none found — trading must not be enabled until a fresh oracle account is available"
    );
  }

  // 8. mints (decimals at SPL Mint offset 44)
  for (const [name, key, decimals] of [
    ["USDC mint", MAINNET.usdcMint, 6],
    ["WSOL mint", MAINNET.wsolMint, 9],
  ] as [string, PublicKey, number][]) {
    const m = await info(key);
    check(`${name} exists with ${decimals} decimals`, !!m && m.data[44] === decimals, m ? `got ${m.data[44]}` : "missing");
  }

  console.log("");
  if (failures) {
    console.error(`PREFLIGHT FAILED: ${failures} check(s) did not pass. DO NOT DEPLOY.`);
    process.exit(1);
  }
  console.log("PREFLIGHT OK — all mainnet dependencies verified. Safe to initialize.");
}

main().catch((e) => {
  console.error("preflight error:", e);
  process.exit(1);
});
