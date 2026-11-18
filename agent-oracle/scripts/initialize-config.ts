#!/usr/bin/env ts-node
/**
 * Initialize the cypher GlobalConfig.
 *
 * Usage (localnet/devnet with mocks):
 *   ts-node scripts/initialize-config.ts \
 *     --cluster localnet --admin id.json --with-mocks
 *
 * For mainnet: pass every address explicitly (see docs/DEPLOYMENT.md) and
 * NEVER use --with-mocks there.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { clusterRpc, Cluster, MAINNET, DEFAULT_RISK } from "../sdk/src/config";
import {
  CypherClient,
  loadIdl,
  STRATEGY,
} from "../sdk/src";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const cluster = (arg("cluster") ?? "localnet") as Cluster;
  const rpc = clusterRpc(cluster, arg("rpc"));
  const connection = new Connection(rpc, "confirmed");
  const adminKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(arg("admin")!, "utf8")))
  );
  const provider = new AnchorProvider(connection, new Wallet(adminKp), {
    commitment: "confirmed",
  });
  const client = new CypherClient(provider, loadIdl());

  const withMocks = !!arg("with-mocks");
  const guardiansArg = arg("guardians") ?? "";
  const guardians = guardiansArg
    ? (guardiansArg.split(",").map((k) => new PublicKey(k)) as [
        PublicKey,
        PublicKey,
        PublicKey
      ])
    : [
        adminKp.publicKey,
        adminKp.publicKey,
        adminKp.publicKey,
      ]; // devnet convenience; use multisigs in production

  const cfg = {
    marinadeProgram: withMocks
      ? new PublicKey(arg("marinade-program")!)
      : MAINNET.marinadeProgram,
    marinadeState: withMocks
      ? new PublicKey(arg("marinade-state")!)
      : MAINNET.marinadeState,
    msolMint: withMocks ? new PublicKey(arg("msol-mint")!) : MAINNET.msolMint,
    msolTreasury: withMocks
      ? new PublicKey(arg("msol-treasury")!)
      : MAINNET.msolTreasury,
    swapProgram: withMocks
      ? new PublicKey(arg("swap-program")!)
      : MAINNET.jupiterV6,
    usdcMint: withMocks ? new PublicKey(arg("usdc-mint")!) : MAINNET.usdcMint,
    wsolMint: withMocks ? new PublicKey(arg("wsol-mint")!) : MAINNET.wsolMint,
    pythReceiverProgram: withMocks
      ? // mocks: the program that owns the fake PriceUpdateV2 account
        (() => {
          const v = arg("pyth-receiver-program");
          if (!v)
            throw new Error(
              "--with-mocks requires --pyth-receiver-program <mock program id> " +
                "(the program that owns the test price account)"
            );
          return new PublicKey(v);
        })()
      : MAINNET.pythReceiver,
    feedId: Buffer.from(
      arg("feed-id") ?? MAINNET.solUsdFeedId.toString("hex"),
      "hex"
    ),
    pythPrice: new PublicKey(arg("pyth-price") ?? PublicKey.default.toBase58()),
  };

  const tx = await client.initialize(
    {
      admin: adminKp.publicKey,
      guardians,
      ...cfg,
      solUsdFeedId: cfg.feedId,
      maxPriceStalenessSecs: DEFAULT_RISK.maxPriceStalenessSecs,
      maxPriceConfBps: DEFAULT_RISK.maxPriceConfBps,
      maxSlippageBps: DEFAULT_RISK.maxSlippageBps,
      minDepositLamports: DEFAULT_RISK.minDepositLamports,
      maxDepositLamports: DEFAULT_RISK.maxDepositLamports,
      maxTradeUsdc: DEFAULT_RISK.maxTradeUsdc,
      minStakeLamports: DEFAULT_RISK.minStakeLamports,
      minReserveLamports: DEFAULT_RISK.minReserveLamports,
      timelockDelaySecs: arg("timelock-delay")
        ? parseInt(arg("timelock-delay")!)
        : DEFAULT_RISK.timelockDelaySecs,
    },
    adminKp
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [adminKp]);
  console.log("initialized. signature:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
void STRATEGY;
