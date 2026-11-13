#!/usr/bin/env ts-node
/**
 * cypher CLI — wallet creation, deposits, strategy control, status.
 *
 * Security notes:
 *  - Wallets are stored encrypted (AES-256-GCM, scrypt-derived key) in
 *    ~/.cypher/wallets/<name>.json. Plaintext keys never touch disk.
 *  - This CLI only builds and signs USER transactions. Strategy execution
 *    is done by the permissionless agent (agent/).
 */
import { Command } from "commander";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createSyncNativeInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { clusterRpc, Cluster } from "../../sdk/src/config";
import {
  CypherClient,
  StrategyParams,
  strategyFromName,
  loadIdl,
  createWallet,
  listWallets,
  loadWallet,
  walletPubkey,
  walletDir,
  deleteWallet,
  positionPda,
  vaultAta,
} from "../../sdk/src";
import * as readline from "readline";

const program = new Command();
program.name("cypher").description(
  "Non-custodial autonomous yield agent for Solana (Agent v1: Cypher)"
);
program.version("1.0.0");

function opts(): { cluster: Cluster; rpc?: string; idl?: string } {
  return program.opts();
}

function connection(): Connection {
  const o = opts();
  return new Connection(clusterRpc(o.cluster ?? "devnet", o.rpc), "confirmed");
}

function client(): CypherClient {
  const c = connection();
  // The CLI never needs a payer for read-only ops; provide a throwaway
  // wallet for the provider (Anchor requires one).
  const throwaway = Keypair.generate();
  const { AnchorProvider, Wallet } = require("@coral-xyz/anchor");
  const provider = new AnchorProvider(c, new Wallet(throwaway), {
    commitment: "confirmed",
  });
  return new CypherClient(provider, opts().idl ? loadIdl(opts().idl!) : undefined);
}

function requirePassword(prompt = "Wallet password: "): string {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  (rl as any).stdoutMuted = true;
  return rl.question(prompt, (answer) => {
    rl.close();
    return answer;
  }) as unknown as string;
}

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) =>
    rl.question(q, (a) => {
      rl.close();
      res(a);
    })
  );
}

async function loadWalletInteractive(name: string): Promise<Keypair> {
  const password = await ask("Wallet password: ");
  return loadWallet(name, password);
}

function parseStrategy(s: string) {
  return strategyFromName(s);
}

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

const wallet = program.command("wallet").description("Encrypted wallet management");

wallet
  .command("create")
  .argument("<name>")
  .description("Create a new encrypted wallet (key never stored in plaintext)")
  .action(async (name: string) => {
    const password = await ask("New wallet password: ");
    const password2 = await ask("Confirm password: ");
    if (password !== password2) throw new Error("Passwords do not match");
    if (password.length < 8) throw new Error("Use at least 8 characters");
    const pk = createWallet(name, password);
    console.log(`Wallet '${name}' created.`);
    console.log(`Public key: ${pk.toBase58()}`);
    console.log(`Encrypted file: ${walletDir()}/${name}.json`);
    console.log(`Fund it on devnet:  solana airdrop 2 ${pk.toBase58()}`);
  });

wallet
  .command("list")
  .action(() => {
    const names = listWallets();
    console.log(names.length ? names.join("\n") : "(no wallets)");
  });

wallet
  .command("show")
  .argument("<name>")
  .action((name: string) => {
    console.log(walletPubkey(name).toBase58());
  });

wallet
  .command("delete")
  .argument("<name>")
  .action((name: string) => {
    deleteWallet(name);
    console.log(`Deleted ${name}`);
  });

// ---------------------------------------------------------------------------
// position lifecycle
// ---------------------------------------------------------------------------

program
  .command("open")
  .argument("<wallet>")
  .requiredOption("--strategy <staking|trading>")
  .description("Open a vault position for the wallet")
  .action(async (name: string, { strategy }: { strategy: string }) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const tx = new Transaction().add(await c.openPosition(kp.publicKey, parseStrategy(strategy)));
    const sig = await sendAndConfirmTransaction(c.connection, tx, [kp]);
    console.log(`Position opened: ${positionPda(kp.publicKey).toBase58()}`);
    console.log(`Signature: ${sig}`);
  });

program
  .command("deposit")
  .argument("<wallet>")
  .requiredOption("--sol <amount>", "SOL amount to deposit")
  .option("--pyth-price <pubkey>", "Pyth SOL/USD PriceUpdateV2 account (required for trading positions)")
  .description("Deposit SOL into your vault")
  .action(async (name: string, a: { sol: string; pythPrice?: string }) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const lamports = Math.round(parseFloat(a.sol) * LAMPORTS_PER_SOL);
    const pos = await c.fetchPosition(kp.publicKey);
    const tx = new Transaction();
    if (Number(pos.strategy) === 2) {
      if (!a.pythPrice) {
        throw new Error("Trading positions need --pyth-price <PriceUpdateV2 account> for cost-basis marking");
      }
      tx.add(await c.depositSolTrading(kp.publicKey, lamports, new PublicKey(a.pythPrice)));
    } else {
      tx.add(await c.depositSol(kp.publicKey, lamports));
    }
    const sig = await sendAndConfirmTransaction(c.connection, tx, [kp]);
    console.log(`Deposited ${a.sol} SOL. Signature: ${sig}`);
  });

program
  .command("deposit-usdc")
  .argument("<wallet>")
  .requiredOption("--amount <usdc>")
  .description("Deposit USDC into your vault (trading strategy)")
  .action(async (name: string, { amount }: { amount: string }) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const micro = Math.round(parseFloat(amount) * 1_000_000);
    const tx = new Transaction().add(await c.depositToken(kp.publicKey, micro));
    const sig = await sendAndConfirmTransaction(c.connection, tx, [kp]);
    console.log(`Deposited ${amount} USDC. Signature: ${sig}`);
  });

program
  .command("start")
  .argument("<wallet>")
  .requiredOption("--strategy <staking|trading>")
  .option("--cycle-mins <minutes>", "DCA cycle / stake cooldown, minutes", "60")
  .option("--trade-usdc <amount>", "USDC per DCA buy (trading)", "10")
  .option("--tp-bps <bps>", "take-profit bps (0=off)", "300")
  .option("--sl-bps <bps>", "stop-loss bps (0=off)", "300")
  .option("--dd-bps <bps>", "max drawdown bps from high-water-mark (0=off)", "1000")
  .option("--slippage-bps <bps>", "max slippage bps", "100")
  .description("START the autonomous strategy for this wallet")
  .action(async (name: string, a: any) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const params: StrategyParams = {
      cycleSecs: Math.round(parseFloat(a.cycleMins) * 60),
      tradeAmountUsdc: Math.round(parseFloat(a.tradeUsdc) * 1_000_000),
      takeProfitBps: parseInt(a.tpBps),
      stopLossBps: parseInt(a.slBps),
      maxDrawdownBps: parseInt(a.ddBps),
      slippageBps: parseInt(a.slippageBps),
    };
    const tx = new Transaction().add(
      await c.startStrategy(kp.publicKey, parseStrategy(a.strategy), params)
    );
    const sig = await sendAndConfirmTransaction(c.connection, tx, [kp]);
    console.log(`Strategy STARTED (${a.strategy}). The agent will act automatically.`);
    console.log(`Signature: ${sig}`);
  });

program
  .command("stop")
  .argument("<wallet>")
  .action(async (name: string) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const sig = await sendAndConfirmTransaction(
      c.connection,
      new Transaction().add(await c.stopStrategy(kp.publicKey)),
      [kp]
    );
    console.log(`Strategy stopped. Signature: ${sig}`);
  });

program
  .command("pause")
  .argument("<wallet>")
  .option("--resume", "resume the strategy cranks")
  .action(async (name: string, { resume }: { resume?: boolean }) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const sig = await sendAndConfirmTransaction(
      c.connection,
      new Transaction().add(await c.setPaused(kp.publicKey, !resume)),
      [kp]
    );
    console.log(`${resume ? "Resumed" : "Paused"}. Signature: ${sig}`);
  });

program
  .command("withdraw")
  .argument("<wallet>")
  .option("--sol <amount>")
  .option("--usdc <amount>")
  .option("--wsol <amount>")
  .description("Withdraw funds to your wallet (works even while paused)")
  .action(async (name: string, a: any) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const tx = new Transaction();
    if (a.sol) tx.add(await c.withdrawSol(kp.publicKey, Math.round(parseFloat(a.sol) * LAMPORTS_PER_SOL)));
    if (a.usdc) tx.add(await c.withdrawUsdc(kp.publicKey, Math.round(parseFloat(a.usdc) * 1_000_000)));
    if (a.wsol) tx.add(await c.withdrawWsol(kp.publicKey, Math.round(parseFloat(a.wsol) * LAMPORTS_PER_SOL)));
    if (tx.instructions.length === 0) throw new Error("Nothing to withdraw");
    const sig = await sendAndConfirmTransaction(c.connection, tx, [kp]);
    console.log(`Withdrawn. Signature: ${sig}`);
  });

program
  .command("unstake")
  .argument("<wallet>")
  .requiredOption("--msol <amount>")
  .description("Instant-unstake mSOL back to SOL (Marinade fee applies)")
  .action(async (name: string, { msol }: { msol: string }) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const tx = new Transaction().add(
      await c.unstakeMsol(kp.publicKey, Math.round(parseFloat(msol) * LAMPORTS_PER_SOL))
    );
    const sig = await sendAndConfirmTransaction(c.connection, tx, [kp]);
    console.log(`Unstaked. Signature: ${sig}`);
  });

program
  .command("close")
  .argument("<wallet>")
  .description("Close the position (must be empty)")
  .action(async (name: string) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const sig = await sendAndConfirmTransaction(
      c.connection,
      new Transaction().add(await c.closePosition(kp.publicKey)),
      [kp]
    );
    console.log(`Position closed. Signature: ${sig}`);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .argument("<wallet>")
  .description("Show vault balances, strategy state and estimated value")
  .action(async (name: string) => {
    const owner = walletPubkey(name);
    const c = client();
    const pos = positionPda(owner);
    const cfg = await c.fetchConfig();
    let p: any = null;
    try {
      p = await c.fetchPosition(owner);
    } catch {
      console.log(`No position for ${owner.toBase58()}. Open one with 'open'.`);
      return;
    }
    const { getAccount } = require("@solana/spl-token");
    const bal = async (mint: PublicKey) => {
      try {
        return (await getAccount(c.connection, vaultAta(pos, mint))).amount as bigint;
      } catch {
        return 0n;
      }
    };
    const msol = await bal(cfg.msolMint);
    const usdc = await bal(cfg.usdcMint);
    const wsol = await bal(cfg.wsolMint);
    const native = await c.connection.getBalance(pos);
    console.log(`Vault:          ${pos.toBase58()}`);
    console.log(`Strategy:       ${["None", "Staking", "Trading"][Number(p.strategy)]}`);
    console.log(`Active:         ${p.active}  Paused: ${p.paused}`);
    console.log(`Native SOL:     ${Number(native) / LAMPORTS_PER_SOL}`);
    console.log(`WSOL:           ${Number(wsol) / LAMPORTS_PER_SOL}`);
    console.log(`mSOL:           ${Number(msol) / LAMPORTS_PER_SOL}`);
    console.log(`USDC:           ${Number(usdc) / 1e6}`);
    console.log(`Staked mSOL:    ${Number(p.stakedMsolAmount) / LAMPORTS_PER_SOL}`);
    console.log(`Position SOL:   ${Number(p.positionSolAmount) / LAMPORTS_PER_SOL}`);
    console.log(`Avg entry:      $${Number(p.avgEntryPrice) / 1e6}`);
    console.log(`Realized PnL:   $${Number(p.realizedPnlUsdc) / 1e6}`);
    console.log(`High water:     $${Number(p.highWaterMark) / 1e6}`);
  });

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

const admin = program.command("admin").description("Protocol administration");
admin
  .command("pause")
  .option("--resume")
  .argument("<authority-name>")
  .action(async (name: string, { resume }: { resume?: boolean }) => {
    const kp = await loadWalletInteractive(name);
    const c = client();
    const sig = await sendAndConfirmTransaction(
      c.connection,
      new Transaction().add(
        resume ? await c.guardianResume(kp.publicKey) : await c.guardianPause(kp.publicKey)
      ),
      [kp]
    );
    console.log(`Global ${resume ? "resume" : "pause"}. Signature: ${sig}`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error("Error:", e?.message ?? e);
  process.exit(1);
});
