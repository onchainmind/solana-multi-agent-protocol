# Mainnet verification report (repro pack)

**Date:** 2026-11-11 · **Cluster:** mainnet-beta · **Method:** read-only RPC +
official upstream sources. Re-run everything below in one command:

```bash
python3 scripts/verify_mainnet.py     # exit 0 = every check passes today
npm run preflight                     # TS preflight (same checks, deploy-gating)
```

Both scripts re-derive every constant from first principles (seeds, borsh
layouts, discriminators) and compare against the live chain. They are part of
the audit repro pack: an auditor does not need to trust this document, only
the script output.

## 1. Marinade Finance

Sources: official `@marinade.finance/marinade-ts-sdk` v6.1.0
(`dist/src/config/marinade-config.js` for addresses,
`dist/src/programs/idl/types/marinade_finance.js` for the IDL).

| Item | Value | Verified by |
| --- | --- | --- |
| Program | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD` | SDK config; deployed + executable on mainnet |
| State | `8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC` | SDK config; owner == Marinade program |
| mSOL mint | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` | bytes 8..40 of state data; SPL mint, 9 decimals |
| mSOL mint authority | `3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM` | == PDA `[state, "st_mint"]` (bump 253) == actual mint authority field |
| Reserve PDA | `Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN` | PDA `[state, "reserve"]` (bump 255); exists, system-owned, holds staked SOL |
| Liq SOL leg | `UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q` | PDA `[state, "liq_sol"]` (bump 254); exists |
| Liq mSOL leg authority | `EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL` | PDA `[state, "liq_st_sol_authority"]` (bump 255); exists |
| Liq mSOL leg | `7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE` | `create_with_seed(state, "liq_st_sol", Token)`; mSOL token account |
| Treasury mSOL account | `B1aLzaNMeFVAyQ6f3XbbUyKcH2YPHu2fqiEagmiF23VR` | bytes 104..136 of state data; mSOL token account |

### deposit / liquidUnstake CPI layout (the authoritative answer)

From the official Marinade IDL (account order, mutability, signer flags):

```
deposit(lamports):                liquid_unstake(msol_amount):
  0  state                  mut    0  state                  mut
  1  msolMint               mut    1  msolMint               mut
  2  liqPoolSolLegPda       mut    2  liqPoolSolLegPda       mut
  3  liqPoolMsolLeg         mut    3  liqPoolMsolLeg         mut
  4  liqPoolMsolLegAuthority       4  treasuryMsolAccount    mut
  5  reservePda             mut    5  getMsolFrom            mut
  6  transferFrom     mut+signer   6  getMsolFromAuthority     signer
  7  mintTo                 mut    7  transferSolTo          mut
  8  msolMintAuthority             8  systemProgram
  9  systemProgram                 9  tokenProgram
 10  tokenProgram
```

Discriminators (recomputed, cross-checked in `programs/cypher/src/cpi/marinade.rs`):

* `sha256("global:deposit")[..8]`        = `f223c68952e1f2b6` — matches
* `sha256("global:liquid_unstake")[..8]` = `1e1e77f0bfe30c10` — matches

PDA hash construction used throughout (verified byte-for-byte against
`@solana/web3.js`): `sha256(seeds… ‖ bump ‖ program_id ‖ "ProgramDerivedAddress")`,
first off-curve candidate from bump 255 downward.

## 2. Jupiter v6

| Item | Value | Verified by |
| --- | --- | --- |
| Program | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | jup-ag/jupiter-cpi `declare_id`; deployed + executable |
| Upgrade authority | **NONE — the deployed program is IMMUTABLE** | ProgramData COption<authority> = None (checked live; `scripts/preflight-mainnet.ts` re-checks every run) |
| `route()` accounts | 9 fixed slots + route accounts | official jupiter-cpi IDL; discriminators recomputed |

## 3. Pyth SOL/USD (single feed)

| Item | Value | Verified by |
| --- | --- | --- |
| Feed id | `ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d` | Pyth docs |
| Receiver program | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` | `pyth-solana-receiver-sdk` v2.0.0 `lib.rs` `declare_id!`; deployed + executable |
| PriceUpdateV2 discriminator | `22f123639d7ef4cd` | sha256("account:PriceUpdateV2")[..8]; 11 309 live accounts carry this prefix |
| Live accounts | ~4 000 for SOL/USD at scan time; freshest 4–10 s old | `getProgramAccounts` scan (memcmp feed id @ offsets 41/42) |
| Canonical address | **none** — receiver accounts are posted by consumers at arbitrary addresses | two fixed-PDA candidates checked: do not exist |

**Consequence for the program's design** (`programs/cypher/src/oracle.rs`):
the trust anchor is **account ownership**, not the address:

1. `owner == config.pyth_receiver_program` (config-pinned, timelock-protected),
2. genuine `PriceUpdateV2` discriminator + borsh layout (variant-aware
   length check — a truncated `Partial` account is rejected, not sliced),
3. embedded feed id == configured SOL/USD feed,
4. staleness / future-skew / confidence bounds.

The classic push-oracle account (address == feed id, program `FsJ3A3u2…`)
is decommissioned on mainnet and is NOT supported — the program is
single-feed, receiver-only by design.

## 4. Token mints

| Item | Value | Verified by |
| --- | --- | --- |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL mint, 6 decimals |
| WSOL | `So11111111111111111111111111111111111111112` | SPL mint, 9 decimals |

## 5. What changed in the program as a result

1. `GlobalConfig` gained `pyth_receiver_program` (config-pinned at
   initialize; changeable only via timelocked `SetOracle`).
2. The oracle path accepts **only** receiver-owned `PriceUpdateV2`
   accounts (legacy push parser removed).
3. The parser's length check is verification-variant aware (a fuzzer
   found the truncated-`Partial` slice panic; fixed + regression-tested).
4. `initialize` rejects the zero receiver program / zero feed id — a
   misconfigured single-feed setup cannot be created.
