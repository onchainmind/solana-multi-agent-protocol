# Deployment runbook

This runbook takes you from a clean clone to a configured program on
**devnet first**, with mainnet notes inline. Follow it top-to-bottom.

## 0. Hygiene (do not skip)

* Generate a **fresh** program keypair locally; never commit it.
* Use a dedicated deploy keypair (payer) with only the SOL it needs.
* Prepare a Squads multisig for: program upgrade authority, admin, guardians.

## 1. Build & keys

```bash
npm install
cargo install anchor-cli --version 0.31.1 --locked   # or avm install 0.31.1

# FRESH keypair for YOUR deployment (do NOT reuse tests/fixtures):
mkdir -p .keys && solana-keygen new --no-bip39-passphrase -o .keys/cypher.json
cp .keys/cypher.json programs/cypher/cypher-keypair.json
anchor keys sync            # updates declare_id + IDL to the new key
# note the printed program id; update sdk/src/config.ts PROGRAM_ID accordingly
anchor build
```

## 2. Deploy to devnet

```bash
solana config set --url devnet
solana airdrop 2 && solana airdrop 2   # repeat as needed (rent + fees)
anchor deploy --provider.cluster devnet
```

## 3. Choose verified addresses

Devnet offers two options:

* **Option A (integration test of the real stack):** look up Marinade's
  devnet state/mint and Pyth's devnet SOL/USD price account. If Marinade
  is not deployed on devnet, use Option B.
* **Option B (ship with mocks on devnet):** deploy the two mock programs
  too (`anchor deploy` deploys everything in Anchor.toml) and pin them in
  config. They are valueless and clearly labelled TEST-ONLY.

Mainnet: use ONLY the addresses in `sdk/src/config.ts`. Every one of them
was verified from primary sources AND from the chain itself (2026-11),
and `scripts/preflight-mainnet.ts` re-verifies all of them on the day
you deploy:

| Role | Address | How it was verified |
| --- | --- | --- |
| Marinade program | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | Marinade docs; deployed + executable on mainnet |
| Marinade state | `8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC` | docs + on-chain (anchor-discriminated State, msol_mint @8) |
| mSOL mint | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` | docs + state bytes + mint authority check |
| Reserve PDA | `Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN` | re-derived `[state, "reserve"]`; holds the staked SOL on-chain |
| Liq SOL leg | `UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q` | re-derived `[state, "liq_sol"]`; system-owned, holds SOL |
| Liq mSOL leg | `7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE` | `create_with_seed(state, "liq_st_sol", Token)`; token acct of mSOL |
| Liq mSOL leg authority | `EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL` | re-derived `[state, "liq_st_sol_authority"]`; **confirmed by simulating a real Marinade deposit on mainnet** (the program's own seeds constraint rejects every other value) |
| mSOL mint authority | `3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM` | re-derived `[state, "st_mint"]` == mSOL mint's actual authority |
| Treasury mSOL account | `B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR` | read from the on-chain State (offset 104); mSOL token account |
| Jupiter v6 | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | jup-ag docs; deployed + executable; route() layout cross-checked against the official jupiter-cpi IDL and real mainnet route instructions |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL registry |
| WSOL | `So11111111111111111111111111111111111111112` | SPL registry |
| Pyth SOL/USD feed id | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` | Pyth docs; the feed id is NOT a price account (see the oracle section below) |
| Pyth receiver program | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` | `pyth-solana-receiver-sdk` v2.0.0 `declare_id!`; deployed + executable; owns every accepted oracle account |

The **mSOL treasury** account (receives Marinade's unstake fee) is
pre-pinned to the verified value above; `initialize-config` accepts an
override if Marinade ever migrates it.

### Oracle supply on mainnet (read this)

The classic Pyth push-oracle accounts (address == feed id, program
`FsJ3A3u2…`) are decommissioned and NOT supported. The live mainnet
mechanism is Pyth's **receiver pull oracle** (`rec5EKMG…LtFJ`,
config-pinned at initialize): Wormhole-verified `PriceUpdateV2` accounts
that consumers post. The program accepts ONLY receiver-owned accounts
and independently re-validates the discriminator, layout, feed id,
staleness and confidence on-chain. The agent obtains a fresh account in
either of two ways (see `agent/src/pyth-updater.ts`):

* `PYTH_SOL_USD_PRICE_ACCOUNT` — an account you keep fresh with Pyth's
  official tooling (Hermes `GET /api/latest_price_updates` + the
  receiver's `post_updates_atomic`), or
* auto-discovery (default on mainnet): the agent scans the receiver
  program for the freshest account carrying the SOL/USD feed id
  (cached scan; requires a production RPC for the heavy
  `getProgramAccounts` call) and refuses to trade when the freshest
  account is older than `PYTH_MAX_STALENESS_SECS`.

## 4. Initialize config

```bash
# 1) verify every mainnet dependency from the chain (exit 1 on any failure):
npx ts-node scripts/preflight-mainnet.ts
# 2) initialize with the verified constants:
ts-node scripts/initialize-config.ts --cluster mainnet-beta --admin <admin.json> \
  --guardians <squads-pda1>,<squads-pda2>,<squads-pda3>
```

Recommended bounds: `max_slippage_bps=200`, `max_price_conf_bps=100`,
`max_price_staleness_secs=60`, `timelock_delay_secs=86400` (24h mainnet;
shorter on devnet only).

Guardians: pass **Squads vault PDAs**, not EOAs.

## 5. Transfer authorities

```bash
# program upgrade authority -> multisig (Squads "use" flow or squads CLI)
# then in the program:
npm run cli -- admin propose-admin <multisig-vault-pda>   # from current admin
# accept from the multisig, then guardian pause drill on devnet
```

## 6. Agent ops

```bash
cp .env.example .env   # fill in RPC, identity, oracle mode
npm run agent
```

* Agent identity = fee payer only; fund it with a few SOL.
* Run 2+ independent agents; they don't coordinate (permissionless).
* Trading on mainnet uses the **live Jupiter Swap API** by default
  (`JUP_API_BASE`, default `https://lite-api.jup.ag/swap/v1`): the agent
  fetches a quote for the position PDA, takes the `route()` instruction
  Jupiter authored, verifies every account/byte against the program's
  on-chain rules (`agent/src/jupiter-route.ts`), and submits it. The
  program independently enforces exact input, an oracle-anchored minimum
  output and `platform_fee_bps == 0`.
* Oracle supply: see the "Oracle supply on mainnet" section above — pin
  `PYTH_SOL_USD_PRICE_ACCOUNT` (self-updated) or rely on receiver
  auto-discovery. Trades are skipped (never sent with a stale price)
  when no fresh account is available.
* Compute budgets: `CRANK_TRADE_CU` ≥ 400k, `CRANK_STAKE_CU` ≥ 150k,
  plus `PRIORITY_FEE_MICRO_LAMPORTS` for congestion.

## 7. Monitoring

All actions emit events (`Staked`, `TradeExecuted`, `Flattened`, ...).
Index them, alert on: `Flattened` (drawdown), `GlobalPaused`,
`ConfigChangeProposed` (unexpected proposals), repeated `SlippageExceeded`.
