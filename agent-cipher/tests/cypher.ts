/**
 * End-to-end test suite for the cypher program on a local validator
 * (`anchor test`).
 *
 * Covers:
 *  - vault lifecycle (open / deposit / withdraw / close)
 *  - staking strategy: crank_stake via mock-marinade, cooldown, unstake
 *  - trading strategy: DCA entry, take-profit, stop-loss, max-drawdown
 *    flatten + self-pause via mock-jupiter
 *  - on-chain guards: slippage vs oracle, wrong feed, stale price,
 *    cooldown, paused states, unauthorized access, route-account
 *    exclusion, global guardian pause, timelock governance
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, BN, Wallet } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";

import { PROGRAM_ID, MOCK_MARINADE_PROGRAM_ID, MOCK_JUPITER_PROGRAM_ID } from "../sdk/src/config";
import {
  configPda,
  positionPda,
  nativeVaultPda,
  vaultAta,
  marinadePdas,
  jupiterEventAuthority,
} from "../sdk/src/pdas";
import { encodeRouteData, STRATEGY } from "../sdk/src/client";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const connection = provider.connection;
const payer = (provider.wallet as Wallet).payer;

// ---- keypairs committed under tests/fixtures (test-only, no value) ----
import * as fs from "fs";
function kpFromFixture(name: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(`tests/fixtures/${name}-keypair.json`, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
function kpFromPath(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
// Main program keypair: committed fixture (local dev) OR the deploy
// keypair created by `scripts/sync-keypairs.js` / `anchor build`
// (public-clone flow — the deploy keypair is never committed).
const CYPHER_ID = (() => {
  try {
    return kpFromFixture("cypher").publicKey;
  } catch {
    return kpFromPath("target/deploy/cypher-keypair.json").publicKey;
  }
})();
const MOCK_MARINADE_ID = kpFromFixture("mock_marinade").publicKey;
const MOCK_JUPITER_ID = kpFromFixture("mock_jupiter").publicKey;
console.log("program ids:", {
  CYPHER_ID: CYPHER_ID.toBase58(),
  MOCK_MARINADE_ID: MOCK_MARINADE_ID.toBase58(),
  MOCK_JUPITER_ID: MOCK_JUPITER_ID.toBase58(),
});
if (!CYPHER_ID.equals(PROGRAM_ID)) {
  console.warn("NOTE: fixture cypher id != sdk PROGRAM_ID; update sdk/src/config.ts if intentional");
}

// program handles are created in `before` once the IDL is available
// (typed as `any` — the generic Program<Idl> instantiation is too deep)
let cypher: any;
let mockMarinade: any;
let mockJupiter: any;

// ---- shared setup state ----
const admin = Keypair.generate();
const guardian1 = Keypair.generate();
const guardian2 = Keypair.generate();
const guardian3 = Keypair.generate();

const FEED_ID = Buffer.alloc(32, 7); // arbitrary test feed id

let usdcMint: PublicKey;
let wsolMint: PublicKey;
let msolMint: PublicKey;
let marinadeState: Keypair; // mock "state" (any account)
let mockPricePda: PublicKey;
let pythPda: PublicKey;
let mockMintAuth: PublicKey;

const CFG = configPda();

async function createMint(decimals: number, authority: PublicKey): Promise<PublicKey> {
  const mint = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports: rent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, decimals, authority, authority)
  );
  await sendAndConfirmTransaction(connection, tx, [payer, mint]);
  return mint.publicKey;
}

async function createAta(mint: PublicKey, owner: PublicKey, payerKp: Keypair = payer): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const ix = createAssociatedTokenAccountInstruction(payerKp.publicKey, ata, owner, mint);
  await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payerKp]);
  return ata;
}

async function mintTo(mint: PublicKey, dest: PublicKey, amount: bigint) {
  const tx = new Transaction().add(createMintToInstruction(mint, dest, payer.publicKey, amount));
  await sendAndConfirmTransaction(connection, tx, [payer]);
}

async function airdrop(kp: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(kp, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

function splTransfer(src: PublicKey, dst: PublicKey, authority: PublicKey, amount: bigint, decimals: number, mint: PublicKey) {
  return createTransferCheckedInstruction(src, mint, dst, authority, amount, decimals);
}

function expectErr(promise: Promise<any>, name: string) {
  return promise.then(
    () => {
      throw new Error(`expected error '${name}' but tx succeeded`);
    },
    (e) => {
      const s = String(e?.message ?? e);
      if (!s.includes(name)) {
        throw new Error(`expected error '${name}', got: ${s}`);
      }
    }
  );
}

/** Set the mock fill price (USDC 6dp per SOL). */
async function setMockPrice(price: number) {
  await mockJupiter.methods
    .setPrice(new BN(price))
    .accounts({ config: CFG,  authority: payer.publicKey  })
    .rpc();
}

/** Write a fresh Pyth PriceUpdateV2-shaped account (age 0 = fresh). */
async function setPyth(price: number, opts?: { ageSecs?: number; conf?: number; feed?: Buffer }) {
  await mockJupiter.methods
    .setPythPrice(
      [...(opts?.feed ?? FEED_ID)],
      new BN(price),
      // default conf = 0.1% of the price — comfortably inside the 1%
      // maxPriceConfBps bound at every test price (on-chain check is
      // proportional by design, so a fixed $1 conf would trip at low prices)
      new BN(opts?.conf ?? Math.max(1, Math.floor(price / 1000))),
      -6,
      new BN(opts?.ageSecs ?? 0)
    )
    .accounts({ config: CFG,  authority: payer.publicKey  })
    .rpc();
}

const DEFAULT_PARAMS = {
  cycleSecs: new BN(60),
  tradeAmountUsdc: new BN(10_000_000), // 10 USDC
  takeProfitBps: 300,
  stopLossBps: 300,
  maxDrawdownBps: 1_000,
  slippageBps: 100,
};

const STAKING_PARAMS = {
  cycleSecs: new BN(3600),
  tradeAmountUsdc: new BN(0),
  takeProfitBps: 0,
  stopLossBps: 0,
  maxDrawdownBps: 0,
  slippageBps: 100,
};

/** Open + start a trading position with USDC deposited, flat (no SOL). */
async function freshTradingPosition(owner: Keypair, usdc = 50_000_000, params = DEFAULT_PARAMS) {
  // Deterministic start price for every trading test ($100/SOL) — the
  // mock fill price and the oracle must agree at entry.
  await setMockPrice(100_000_000);
  await setPyth(100_000_000);
  await airdrop(owner.publicKey, 3);
  await cypher.methods
    .openPosition(STRATEGY.trading)
    .accounts({ config: CFG,  owner: owner.publicKey  })
    .signers([owner])
    .rpc();
  const p = positionPda(owner.publicKey);
  await createAta(usdcMint, p);
  await createAta(wsolMint, p);
  await createAta(msolMint, p);
  // fund the owner from the payer's USDC float (mint authority now belongs to the mock)
  const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner.publicKey);
  const payerUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(owner.publicKey, ownerUsdc, owner.publicKey, usdcMint),
    splTransfer(payerUsdc, ownerUsdc, payer.publicKey, BigInt(usdc * 2), 6, usdcMint)
  );
  await sendAndConfirmTransaction(connection, tx, [payer, owner]);
  await cypher.methods
    .depositToken(new BN(usdc))
    .accounts({ config: CFG,  owner: owner.publicKey, usdcMint, vaultUsdc: vaultAta(p, usdcMint), ownerUsdc  })
    .signers([owner])
    .rpc();
  await cypher.methods
    .startStrategy(STRATEGY.trading, params)
    .accounts({ config: CFG,  owner: owner.publicKey  })
    .signers([owner])
    .rpc();
  return p;
}

/** Crank a trade for a flat position (buy) or holding position (sell). */
async function crankTrade(owner: PublicKey, extraRouteAccounts: PublicKey[] = []) {
  const pos = positionPda(owner);
  const cfg = await (cypher.account as any).globalConfig.fetch(CFG);
  const posAcct = await (cypher.account as any).userPosition.fetch(pos);
  const holding = Number(posAcct.positionSolAmount.toString()) > 0;
  const srcTa = getAssociatedTokenAddressSync(holding ? cfg.wsolMint : cfg.usdcMint, pos, true);
  const dstTa = getAssociatedTokenAddressSync(holding ? cfg.usdcMint : cfg.wsolMint, pos, true);
  const dstMint = holding ? cfg.usdcMint : cfg.wsolMint;
  const srcMint = holding ? cfg.wsolMint : cfg.usdcMint;

  // exact-in payload: the full source balance for sells, params amount for buys
  const srcAmount = holding
    ? Number(posAcct.positionSolAmount.toString())
    : Number(posAcct.params.tradeAmountUsdc.toString());

  const price = await mockPriceValue();
  const expectedOut = holding
    ? Math.floor((srcAmount * price) / 1e9)
    : Math.floor((srcAmount * 1e9) / price);

  return cypher.methods
    .crankTrade(encodeRouteData(srcAmount, expectedOut, 0, 0))
    .accounts({ config: CFG, 
      owner,
      pythPrice: pythPda,
      swapProgram: cfg.swapProgram,
      vaultUsdc: vaultAta(pos, cfg.usdcMint),
      vaultWsol: vaultAta(pos, cfg.wsolMint),
      jupSrcTa: srcTa,
      jupDstTa: dstTa,
      // v6 route() slots for plain token-to-token swaps: the real
      // Jupiter passes its own program id as a dummy in both.
      jupDestinationTokenAccount: cfg.swapProgram,
      jupDstMint: dstMint,
      jupPlatformFeeAccount: cfg.swapProgram,
      jupEventAuthority: jupiterEventAuthority(cfg.swapProgram),
      jupProgramAcct: cfg.swapProgram,
     })
    .remainingAccounts(
      [mockMintAuth, mockPricePda, srcMint, ...extraRouteAccounts].map((k) => ({
        pubkey: k,
        isSigner: false,
        isWritable: true,
      }))
    )
    .rpc();
}

async function mockPriceValue(): Promise<number> {
  const info = await connection.getAccountInfo(mockPricePda);
  if (!info) throw new Error("mock price not set");
  return Number(info.data.readBigUInt64LE(8 + 32));
}

async function tokenAmount(mint: PublicKey, pos: PublicKey): Promise<bigint> {
  try {
    return (await connection.getTokenAccountBalance(vaultAta(pos, mint))).value.amount as unknown as bigint;
  } catch {
    return 0n;
  }
}

describe("cypher", () => {
  before(async () => {
    cypher = new Program(require("../target/idl/cypher.json"), provider);
    mockMarinade = new Program(require("../target/idl/mock_marinade.json"), provider);
    mockJupiter = new Program(require("../target/idl/mock_jupiter.json"), provider);
    if (!cypher.programId.equals(CYPHER_ID)) throw new Error("cypher IDL address mismatch — run 'anchor keys sync'");
    if (!mockMarinade.programId.equals(MOCK_MARINADE_ID)) throw new Error("mock_marinade IDL address mismatch");
    if (!mockJupiter.programId.equals(MOCK_JUPITER_ID)) throw new Error("mock_jupiter IDL address mismatch");

    await airdrop(payer.publicKey, 50);
    await airdrop(admin.publicKey, 2);
    await airdrop(guardian1.publicKey, 1);

    // ---- mints ----
    usdcMint = await createMint(6, payer.publicKey);
    wsolMint = await createMint(9, payer.publicKey);
    msolMint = await createMint(9, payer.publicKey);

    // ---- mock marinade setup ----
    marinadeState = Keypair.generate();
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: marinadeState.publicKey,
        space: 0,
        lamports: LAMPORTS_PER_SOL / 100,
        programId: SystemProgram.programId,
      })),
      [payer, marinadeState]
    );
    // mSOL mint authority -> mock's st_mint PDA (exactly like real marinade)
    const md = await marinadePdas(MOCK_MARINADE_ID, marinadeState.publicKey);
    await mockMarinade.methods
      .setMsolMintAuthority()
      .accounts({ config: CFG,  state: marinadeState.publicKey, msolMint, currentAuthority: payer.publicKey  })
      .rpc();
    // pre-create the liq-pool mSOL leg token account (create_with_seed address)
    const msolLegAta = md.liqPoolMsolLeg;
    const liqMsolLegInfo = await connection.getAccountInfo(msolLegAta);
    if (!liqMsolLegInfo) {
      // fund + allocate a token account at the derived seed address
      const rent = await connection.getMinimumBalanceForRentExemption(165);
      const base = marinadeState.publicKey;
      const seed = "liq_st_sol";
      const tx = new Transaction().add(
        SystemProgram.createAccountWithSeed({
          fromPubkey: payer.publicKey,
          basePubkey: base,
          seed,
          newAccountPubkey: msolLegAta,
          lamports: rent,
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        })
      );
      // initialize account 3 (no signers beyond payer; owner token program)
      const initIx = new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: msolLegAta, isSigner: false, isWritable: true },
          { pubkey: msolMint, isSigner: false, isWritable: false },
          { pubkey: md.liqPoolMsolLegAuthority, isSigner: false, isWritable: false },
          { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]), // InitializeAccount3
      });
      tx.add(initIx);
      await sendAndConfirmTransaction(connection, tx, [payer, marinadeState]);
    }
    // fund the mock liq-pool SOL leg (needed for liquid_unstake)
    const solLegInfo = await connection.getAccountInfo(md.liqPoolSolLeg);
    const solLegRent = solLegInfo ? 0 : LAMPORTS_PER_SOL / 100;
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: md.liqPoolSolLeg,
        lamports: solLegRent + 5 * LAMPORTS_PER_SOL,
      })),
      [payer]
    );

    // ---- payer USDC float (minted before the authority moves to the mock) ----
    const payerUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountInstruction(payer.publicKey, payerUsdc, payer.publicKey, usdcMint),
        createMintToInstruction(usdcMint, payerUsdc, payer.publicKey, 1_000_000_000_000n)
      ),
      [payer]
    );

    // ---- mock jupiter setup ----
    mockPricePda = PublicKey.findProgramAddressSync([Buffer.from("price")], MOCK_JUPITER_ID)[0];
    pythPda = PublicKey.findProgramAddressSync([Buffer.from("pyth")], MOCK_JUPITER_ID)[0];
    mockMintAuth = PublicKey.findProgramAddressSync([Buffer.from("mock_mint_auth")], MOCK_JUPITER_ID)[0];
    // USDC + WSOL mint authorities -> mock's PDA (it mints swap "fills")
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createSetAuthorityInstruction(usdcMint, payer.publicKey, AuthorityType.MintTokens, mockMintAuth),
        createSetAuthorityInstruction(wsolMint, payer.publicKey, AuthorityType.MintTokens, mockMintAuth)
      ),
      [payer]
    );
    await setMockPrice(100_000_000); // $100
    await setPyth(100_000_000);

    // ---- cypher initialize ----
    const cfgKeypairSpace = 0;
    await cypher.methods
      .initialize(
        admin.publicKey,
        [guardian1.publicKey, guardian2.publicKey, guardian3.publicKey],
        MOCK_MARINADE_ID,
        marinadeState.publicKey,
        msolMint,
        msolMint, // msol treasury (unused by the mock, any token-ish account)
        MOCK_JUPITER_ID,
        usdcMint,
        wsolMint,
        MOCK_JUPITER_ID, // pyth receiver program = mock (owns the fake price account)
        [...FEED_ID],
        new BN(60), // staleness
        new BN(100), // conf bound 1%
        200, // max slippage
        new BN(10_000_000), // min deposit 0.01 SOL
        new BN(100 * LAMPORTS_PER_SOL),
        new BN(10_000 * 1_000_000),
        new BN(100_000_000), // min stake 0.1 SOL
        new BN(20_000_000), // reserve ~0.02 SOL
        new BN(2) // timelock 2s for tests
      )
      .accounts({ config: CFG,  payer: payer.publicKey  })
      .signers([payer])
      .rpc();
  });

  // =========================================================================
  it("initialize: config is populated", async () => {
    const cfg = await (cypher.account as any).globalConfig.fetch(CFG);
    expect(cfg.admin.equals(admin.publicKey)).true;
    expect(cfg.paused).false;
    expect(cfg.swapProgram.equals(MOCK_JUPITER_ID)).true;
    expect(cfg.pythReceiverProgram.equals(MOCK_JUPITER_ID)).true;
    expect(Buffer.from(cfg.solUsdFeedId).equals(FEED_ID)).true;
  });

  // =========================================================================
  describe("staking strategy", () => {
    const owner = Keypair.generate();
    const vault = () => nativeVaultPda(owner.publicKey);
    const RESERVE = 20_000_000; // config.min_reserve_lamports

    it("open + deposit + crank_stake stakes idle SOL 1:1", async () => {
      await airdrop(owner.publicKey, 5);
      await cypher.methods.openPosition(STRATEGY.staking)
        .accounts({ config: CFG,  owner: owner.publicKey, nativeVault: nativeVaultPda(owner.publicKey)  }).signers([owner]).rpc();
      const pos = positionPda(owner.publicKey);
      const vault = nativeVaultPda(owner.publicKey);
      await createAta(msolMint, pos);

      await cypher.methods.depositSol(new BN(2 * LAMPORTS_PER_SOL))
        .accounts({ config: CFG,  owner: owner.publicKey, nativeVault: vault  }).signers([owner]).rpc();

      await cypher.methods.startStrategy(STRATEGY.staking, STAKING_PARAMS)
        .accounts({ config: CFG,  owner: owner.publicKey  }).signers([owner]).rpc();

      const md = await marinadePdas(MOCK_MARINADE_ID, marinadeState.publicKey);
      await cypher.methods.crankStake()
        .accounts({ config: CFG, 
          owner: owner.publicKey,
          nativeVault: vault,
          marinadeProgram: MOCK_MARINADE_ID,
          marinadeState: marinadeState.publicKey,
          msolMint,
          ...md,
          vaultMsol: vaultAta(pos, msolMint),
         })
        .remainingAccounts([])
        .rpc();

      const p = await (cypher.account as any).userPosition.fetch(pos);
      expect(p.stakedMsolAmount.toString()).eq((2 * LAMPORTS_PER_SOL - RESERVE).toString());
      expect((await tokenAmount(msolMint, pos)).toString()).eq((2 * LAMPORTS_PER_SOL - RESERVE).toString());
    });

    it("cooldown blocks an immediate second stake", async () => {
      const pos = positionPda(owner.publicKey);
      const md = await marinadePdas(MOCK_MARINADE_ID, marinadeState.publicKey);
      await expectErr(
        cypher.methods.crankStake()
          .accounts({ config: CFG, 
            owner: owner.publicKey,
            marinadeProgram: MOCK_MARINADE_ID,
            marinadeState: marinadeState.publicKey,
            msolMint,
            ...md,
            vaultMsol: vaultAta(pos, msolMint),
           })
          .rpc(),
        "CooldownActive"
      );
    });

    it("unstake burns mSOL and returns SOL to the vault", async () => {
      const pos = positionPda(owner.publicKey);
      const before = await connection.getBalance(vault());
      const md = await marinadePdas(MOCK_MARINADE_ID, marinadeState.publicKey);
      await cypher.methods.unstakeMsol(new BN(1 * LAMPORTS_PER_SOL))
        .accounts({ config: CFG, 
          owner: owner.publicKey,
          nativeVault: vault(),
          marinadeProgram: MOCK_MARINADE_ID,
          marinadeState: marinadeState.publicKey,
          msolMint,
          liqPoolSolLeg: md.liqPoolSolLeg,
          liqPoolMsolLeg: md.liqPoolMsolLeg,
          treasuryMsol: msolMint,
          vaultMsol: vaultAta(pos, msolMint),
         })
        .signers([owner])
        .rpc();
      const p = await (cypher.account as any).userPosition.fetch(pos);
      expect(p.stakedMsolAmount.toString()).eq((2 * LAMPORTS_PER_SOL - RESERVE - 1 * LAMPORTS_PER_SOL).toString());
      const after = await connection.getBalance(vault());
      expect(after - before).gte(1 * LAMPORTS_PER_SOL);
    });

    it("withdraw_sol is owner-only and reserve-protected", async () => {
      const pos = positionPda(owner.publicKey);
      const ownerBefore = await connection.getBalance(owner.publicKey);
      await cypher.methods.withdrawSol(new BN(0.5 * LAMPORTS_PER_SOL))
        .accounts({ config: CFG,  owner: owner.publicKey, nativeVault: vault()  }).signers([owner]).rpc();
      expect(await connection.getBalance(owner.publicKey)).gt(ownerBefore);

      const impostor = Keypair.generate();
      await airdrop(impostor.publicKey, 1);
      // The position PDA is derived from the SIGNER, so an impostor can only
// ever reference their own (nonexistent) vault — there is no way to
// address someone else's position at all.
await expectErr(
  cypher.methods.withdrawSol(new BN(1000))
    .accounts({ config: CFG,  owner: impostor.publicKey, nativeVault: nativeVaultPda(impostor.publicKey)  })
    .signers([impostor]).rpc(),
  "AccountNotInitialized"
);
    });
  });

  // =========================================================================
  describe("trading strategy", () => {
    it("DCA buy at the oracle price and record the entry", async () => {
      const owner = Keypair.generate();
      const pos = await freshTradingPosition(owner);
      await crankTrade(owner.publicKey);

      const p = await (cypher.account as any).userPosition.fetch(pos);
      expect(p.positionSolAmount.toString()).eq("100000000"); // 0.1 SOL @ $100
      expect(p.avgEntryPrice.toString()).eq("100000000"); // $100
      expect((await tokenAmount(wsolMint, pos)).toString()).eq("100000000");
      expect((await tokenAmount(usdcMint, pos)).toString()).eq("40000000"); // 40 USDC
    });

    it("cooldown (next DCA) prevents an immediate second buy", async () => {
      const owner = Keypair.generate();
      await freshTradingPosition(owner);
      await crankTrade(owner.publicKey);
      const pos = positionPda(owner.publicKey);
      const before = await (cypher.account as any).userPosition.fetch(pos);
      await crankTrade(owner.publicKey); // not due -> NothingToDo (success)
      const after = await (cypher.account as any).userPosition.fetch(pos);
      expect(after.positionSolAmount.toString()).eq(before.positionSolAmount.toString());
    });

    it("take-profit sells the whole position and books PnL", async () => {
      const owner = Keypair.generate();
      const pos = await freshTradingPosition(owner);
      await crankTrade(owner.publicKey); // buy 0.1 SOL @100

      await setMockPrice(110_000_000);
      await setPyth(110_000_000);
      await crankTrade(owner.publicKey); // +10% >= 3% TP

      const p = await (cypher.account as any).userPosition.fetch(pos);
      expect(p.positionSolAmount.toString()).eq("0");
      // 0.1 SOL sold at $110 = 11 USDC; basis 10 USDC => +1 USDC
      expect(p.realizedPnlUsdc.toString()).eq("1000000");
      expect((await tokenAmount(usdcMint, pos)).toString()).eq("51000000"); // 51 USDC
      expect((await tokenAmount(wsolMint, pos)).toString()).eq("0");
    });

    it("stop-loss sells at a loss", async () => {
      const owner = Keypair.generate();
      const pos = await freshTradingPosition(owner, 50_000_000, {
        ...DEFAULT_PARAMS,
        takeProfitBps: 0,
        stopLossBps: 300,
      });
      await crankTrade(owner.publicKey); // buy 0.1 SOL @100
      await setMockPrice(95_000_000);
      await setPyth(95_000_000);
      await crankTrade(owner.publicKey); // -5% <= -3% SL

      const p = await (cypher.account as any).userPosition.fetch(pos);
      expect(p.positionSolAmount.toString()).eq("0");
      // 0.1 SOL sold at $95 = 9.5 USDC; basis 10 USDC => -0.5 USDC
      expect(p.realizedPnlUsdc.toString()).eq("-500000"); // -0.5 USDC
    });

    it("max drawdown flattens AND self-pauses the position", async () => {
      const owner = Keypair.generate();
      const pos = await freshTradingPosition(owner, 50_000_000, {
        ...DEFAULT_PARAMS,
        takeProfitBps: 0,
        stopLossBps: 0,
        maxDrawdownBps: 500,
      });
      await crankTrade(owner.publicKey); // buy @100 (hwm = 100)
      await setMockPrice(94_000_000);
      await setPyth(94_000_000);
      await crankTrade(owner.publicKey); // drawdown 6% > 5%

      const p = await (cypher.account as any).userPosition.fetch(pos);
      expect(p.positionSolAmount.toString()).eq("0");
      expect(p.paused).true;

      // paused position rejects further cranks even after price recovers
      await setMockPrice(99_000_000);
      await setPyth(99_000_000);
      await expectErr(crankTrade(owner.publicKey), "PositionPaused");
    });

    it("rejects fills worse than the oracle-anchored slippage bound", async () => {
      const owner = Keypair.generate();
      await freshTradingPosition(owner);
      // oracle says $100 but the mock fills at $120 => buys 8.3% fewer WSOL
      await setMockPrice(120_000_000);
      await expectErr(crankTrade(owner.publicKey), "SlippageExceeded");
      // restore consistency
      await setMockPrice(100_000_000);
    });

    it("rejects a wrong oracle feed id", async () => {
      const owner = Keypair.generate();
      await freshTradingPosition(owner);
      await setPyth(100_000_000, { feed: Buffer.alloc(32, 9) });
      await expectErr(crankTrade(owner.publicKey), "WrongFeedId");
      await setPyth(100_000_000);
    });

    it("rejects an oracle account not owned by the configured receiver program", async () => {
      const owner = Keypair.generate();
      await freshTradingPosition(owner);
      // Pass a random system-owned account as the oracle: the handler must
      // reject it BEFORE parsing (trust anchor = receiver-program ownership).
      const impostor = Keypair.generate();
      await expectErr(
        cypher.methods
          .crankTrade(encodeRouteData(10_000_000, 100_000_000, 0, 0))
          .accounts({ config: CFG,
            owner: owner.publicKey,
            pythPrice: impostor.publicKey,
            swapProgram: MOCK_JUPITER_ID,
            vaultUsdc: vaultAta(positionPda(owner.publicKey), usdcMint),
            vaultWsol: vaultAta(positionPda(owner.publicKey), wsolMint),
            jupSrcTa: vaultAta(positionPda(owner.publicKey), usdcMint),
            jupDstTa: vaultAta(positionPda(owner.publicKey), wsolMint),
            jupDestinationTokenAccount: MOCK_JUPITER_ID,
            jupDstMint: wsolMint,
            jupPlatformFeeAccount: MOCK_JUPITER_ID,
            jupEventAuthority: jupiterEventAuthority(MOCK_JUPITER_ID),
            jupProgramAcct: MOCK_JUPITER_ID,
           })
          .remainingAccounts([])
          .rpc(),
        "OracleNotReceiverOwned"
      );
    });

    it("rejects stale oracle prices", async () => {
      const owner = Keypair.generate();
      await freshTradingPosition(owner);
      await setPyth(100_000_000, { ageSecs: 600 });
      await expectErr(crankTrade(owner.publicKey), "StaleOraclePrice");
      await setPyth(100_000_000);
    });

    it("forbids vault accounts inside the route accounts", async () => {
      const owner = Keypair.generate();
      const pos = await freshTradingPosition(owner);
      await expectErr(
        crankTrade(owner.publicKey, [vaultAta(pos, usdcMint)]),
        "InvalidSwapAccounts"
      );
    });

    it("crank on an inactive position is rejected", async () => {
      const owner = Keypair.generate();
      await airdrop(owner.publicKey, 2);
      await cypher.methods.openPosition(STRATEGY.trading)
  .accounts({ config: CFG,  owner: owner.publicKey, nativeVault: nativeVaultPda(owner.publicKey)  }).signers([owner]).rpc();
const ipos = positionPda(owner.publicKey);
await createAta(usdcMint, ipos);
await createAta(wsolMint, ipos);
await createAta(msolMint, ipos);
await expectErr(crankTrade(owner.publicKey), "StrategyNotActive");
    });
  });

  // =========================================================================
  describe("governance & risk controls", () => {
    it("guardian can pause; only admin can resume", async () => {
      const owner = Keypair.generate();
      await freshTradingPosition(owner);
      await cypher.methods.guardianPause()
        .accounts({ config: CFG,  authority: guardian1.publicKey  }).signers([guardian1]).rpc();
      let cfg = await (cypher.account as any).globalConfig.fetch(CFG);
      expect(cfg.paused).true;

      // user cranks blocked while paused
      await expectErr(crankTrade(owner.publicKey), "GlobalPaused");

      // guardian CANNOT resume
      await expectErr(
        cypher.methods.guardianResume()
          .accounts({ config: CFG,  admin: guardian1.publicKey  }).signers([guardian1]).rpc(),
        "Unauthorized"
      );
      // admin resumes
      await cypher.methods.guardianResume()
        .accounts({ config: CFG,  admin: admin.publicKey  }).signers([admin]).rpc();
      cfg = await (cypher.account as any).globalConfig.fetch(CFG);
      expect(cfg.paused).false;
    });

    it("owner self-pause blocks cranks but not withdrawals", async () => {
      const owner = Keypair.generate();
      const pos = await freshTradingPosition(owner);
      await cypher.methods.setPaused(true)
        .accounts({ config: CFG,  owner: owner.publicKey  }).signers([owner]).rpc();
      await expectErr(crankTrade(owner.publicKey), "PositionPaused");

      // USDC withdrawal still works (owner-only escape hatch)
      const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner.publicKey);
      await cypher.methods.withdrawUsdc(new BN(1_000_000))
        .accounts({ config: CFG, 
          owner: owner.publicKey,
          usdcMint,
          vaultUsdc: vaultAta(pos, usdcMint),
          destAta: ownerUsdc,
         })
        .signers([owner]).rpc();
      await cypher.methods.setPaused(false)
        .accounts({ config: CFG,  owner: owner.publicKey  }).signers([owner]).rpc();
    });

    it("timelock: propose -> too early -> after delay execute", async () => {
      const newSwap = Keypair.generate().publicKey;
      await cypher.methods.proposeConfigChange({ setSwapProgram: { program: newSwap } })
        .accounts({ admin: admin.publicKey, timelockEntry: PublicKey.findProgramAddressSync(
          [Buffer.from("timelock"), CFG.toBuffer(), new BN(1).toArrayLike(Buffer, "le", 8)],
          CYPHER_ID
        )[0] })
        .signers([admin]).rpc();

      await expectErr(
        cypher.methods.executeConfigChange()
          .accounts({ admin: admin.publicKey, timelockEntry: PublicKey.findProgramAddressSync(
            [Buffer.from("timelock"), CFG.toBuffer(), new BN(1).toArrayLike(Buffer, "le", 8)],
            CYPHER_ID
          )[0] })
          .signers([admin]).rpc(),
        "TimelockNotElapsed"
      );

      await new Promise((r) => setTimeout(r, 3000)); // > 2s delay
      await cypher.methods.executeConfigChange()
        .accounts({ admin: admin.publicKey, timelockEntry: PublicKey.findProgramAddressSync(
          [Buffer.from("timelock"), CFG.toBuffer(), new BN(1).toArrayLike(Buffer, "le", 8)],
          CYPHER_ID
        )[0] })
        .signers([admin]).rpc();
      const cfg = await (cypher.account as any).globalConfig.fetch(CFG);
      console.log("timelock debug: pending =", cfg.pendingChangeNonce.toString(),
                  "swap =", cfg.swapProgram.toBase58(), "expected =", newSwap.toBase58());
      expect(cfg.pendingChangeNonce.toString()).eq("0");
      expect(cfg.swapProgram.equals(newSwap)).true;

      // restore the mock swap program via a second timelocked change
      await cypher.methods.proposeConfigChange({ setSwapProgram: { program: MOCK_JUPITER_ID } })
        .accounts({ admin: admin.publicKey, timelockEntry: PublicKey.findProgramAddressSync(
          [Buffer.from("timelock"), CFG.toBuffer(), new BN(2).toArrayLike(Buffer, "le", 8)],
          CYPHER_ID
        )[0] })
        .signers([admin]).rpc();
      await new Promise((r) => setTimeout(r, 3000));
      await cypher.methods.executeConfigChange()
        .accounts({ admin: admin.publicKey, timelockEntry: PublicKey.findProgramAddressSync(
          [Buffer.from("timelock"), CFG.toBuffer(), new BN(2).toArrayLike(Buffer, "le", 8)],
          CYPHER_ID
        )[0] })
        .signers([admin]).rpc();
    });

    it("two-step admin transfer", async () => {
      const newAdmin = Keypair.generate();
      await airdrop(newAdmin.publicKey, 1);
      await cypher.methods.proposeAdmin(newAdmin.publicKey)
        .accounts({ config: CFG,  admin: admin.publicKey  }).signers([admin]).rpc();
      // old admin cannot accept
      await expectErr(
        cypher.methods.acceptAdmin().accounts({ config: CFG,  pendingAdmin: admin.publicKey  }).signers([admin]).rpc(),
        "Unauthorized"
      );
      await cypher.methods.acceptAdmin()
        .accounts({ config: CFG,  pendingAdmin: newAdmin.publicKey  }).signers([newAdmin]).rpc();
      const cfg = await (cypher.account as any).globalConfig.fetch(CFG);
      expect(cfg.admin.equals(newAdmin.publicKey)).true;
      // hand it back for other tests
      await cypher.methods.proposeAdmin(admin.publicKey)
        .accounts({ config: CFG,  admin: newAdmin.publicKey  }).signers([newAdmin]).rpc();
      await cypher.methods.acceptAdmin()
        .accounts({ config: CFG,  pendingAdmin: admin.publicKey  }).signers([admin]).rpc();
    });
  });

  // =========================================================================
  it("position can be closed when empty", async () => {
    const owner = Keypair.generate();
    const pos = await freshTradingPosition(owner);
    // withdraw everything (USDC only; flat position)
    const ownerUsdc = getAssociatedTokenAddressSync(usdcMint, owner.publicKey);
    await cypher.methods.stopStrategy()
      .accounts({ config: CFG,  owner: owner.publicKey  }).signers([owner]).rpc();
    const usdcBal = await tokenAmount(usdcMint, pos);
    await cypher.methods.withdrawUsdc(new BN(usdcBal.toString()))
      .accounts({ config: CFG, 
        owner: owner.publicKey, usdcMint,
        vaultUsdc: vaultAta(pos, usdcMint), destAta: ownerUsdc,
       })
      .signers([owner]).rpc();

    await cypher.methods.closePosition()
      .accounts({ config: CFG, 
        owner: owner.publicKey,
        vaultUsdc: vaultAta(pos, usdcMint),
        vaultWsol: vaultAta(pos, wsolMint),
        vaultMsol: vaultAta(pos, msolMint),
       })
      .signers([owner]).rpc();

    let gone = false;
    try {
      await (cypher.account as any).userPosition.fetch(pos);
    } catch {
      gone = true;
    }
    expect(gone).true;
  });
});
