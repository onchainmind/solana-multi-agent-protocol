# Architecture

## Overview

`Cypher` is split into three trust domains:

1. **On-chain program** (`programs/cypher`) — holds all user funds, all
   strategy logic and all risk enforcement. Trust anchor of the system.
2. **Users** — sign their own deposits/withdrawals/config. Nothing else.
3. **Agent(s)** (`agent/`) — untrusted submitters of *permissionless
   cranks*. Any party (including users themselves) can run one; the
   program is designed so a malicious agent can at worst DoS itself
   (send failing transactions), never steal or misdirect funds.

## Accounts

| Account | PDA seeds | Purpose |
| --- | --- | --- |
| `GlobalConfig` | `["config"]` | Singleton: admin, guardians, CPI targets, oracle params, risk bounds, timelock state |
| `UserPosition` | `["position", owner]` | The vault itself (holds native SOL) + strategy state |
| vault USDC / WSOL / mSOL | ATAs of the position PDA | SPL token custody; authority = position PDA |
| `TimelockEntry` | `["timelock", config, nonce]` | One queued config change |

Design invariant: **the position PDA is the only authority of its token
accounts, and only the owner can instruct the program to move tokens
out.** Program logic moves tokens only between the vault and the two
whitelisted endpoints (Marinade / Jupiter), under instruction-level guards.

## Strategy state machine (trading)

```
        start_strategy(trading, params)
                     │
                     ▼
     ┌────────── FLAT ──────────┐        crank_trade (on-chain decides):
     │  next_dca_at = now       │── due & affordable ──► DCA BUY (USDC→WSOL)
     │  usdc = DCA budget       │◄── full sell ─────────  avg_entry = fill price
     └──────────────────────────┘                         hwm = price
                     ▲                                    │
                     │ TP / SL / DD trigger               ▼
                     │ (price from Pyth)          ┌──── HOLDING ────┐
                     └────────────────────────────┤  hwm updated     │
                        DD exit ⇒ paused=true     │  watch triggers  │
                        (circuit breaker)         └──────────────────┘
```

Every input to the branch decision is on-chain data: `Clock`, the parsed
Pyth price (feed id + freshness + confidence checked), and the position's
own parameters. The client-provided route payload is treated as opaque;
it cannot influence amounts, prices or mints.

## Swap safety (Jupiter pass-through)

The program does not embed AMM logic; it CPIs Jupiter v6's `route` with a
client-assembled route, and neutralizes the trust issue with post-conditions:

1. `swap_program == config.swap_program` (pinned; timelocked to change).
2. src/dst token accounts **must** be the vault ATAs, in the correct
   role for the side (buy: USDC→WSOL, sell: WSOL→USDC).
3. destination mint must be the whitelisted counterpart.
4. Jupiter's event authority PDA must derive from the swap program.
5. `ctx.remaining_accounts` (the route) may contain **no** vault account.
6. Exact input: source balance must drop by exactly the planned amount.
7. Output floor: destination must receive ≥ oracle-expected output ×
   (1 − user slippage). A hostile/buggy route then reverts atomically.

Posture of the external dependencies (verified live on mainnet,
2026-11 — see `docs/MAINNET_VERIFICATION.md`): the deployed Jupiter v6
program is **immutable** (no upgrade authority); Marinade and the Pyth
receiver remain upgradeable, which is why their IDs are config-pinned
(timelock-guarded) and every account they touch is re-derived /
re-validated on-chain. MEV between the oracle read and the fill is
bounded by the user's own slippage parameter, and the transaction
reverts atomically beyond it.

Oracle trust anchor: the program accepts ONLY `PriceUpdateV2` accounts
owned by the config-pinned Pyth Solana Receiver program
(`rec5EKMG…LtFJ`) — the receiver writes nothing but Wormhole-verified
Pyth messages, so ownership is a complete trust anchor for the pull
oracle. Feed id / staleness / confidence are re-checked on every read
(single feed: SOL/USD, by design).

## Staking safety (Marinade CPI)

The program re-derives **every** Marinade PDA it passes
(`reserve`, `st_mint`, `liq_sol`, `liq_st_sol_authority`,
`create_with_seed(state,"liq_st_sol",token)`) from the configured state
account before the CPI — a wrong account cannot be substituted. The stake
amount is computed on-chain (idle lamports above `min_reserve`) and can
never exceed the vault balance. Marinade re-validates everything on its
side; trust in Marinade is limited to "their program is correct", which is
their audit's job, and is why the CPI target is config-pinned.

## Governance

* **Timelock**: every non-trivial config change (swap program, Marinade
  pins, oracle params, risk bounds, guardian set) is queued in a
  `TimelockEntry` PDA and can be executed only after
  `timelock_delay_secs`. The delay itself can only ever be increased.
* **Admin transfer** is two-step (propose → accept by the new admin).
* **Guardians** (any of 3, ideally multisig vault PDAs) can globally pause.
  Only the admin can resume — break-glass without permanent veto power.
* **Users** can self-pause (blocks cranks for their position only) and can
  always withdraw. There is no admin withdrawal anywhere in the code.

## The agent

Solana has no in-protocol cron; "autonomous" execution is an agent
polling state and landing crank transactions. The agent in `agent/`:

* reads the config (skips everything while globally paused),
* scans positions with `getProgramAccounts` memcmp filters
  (`active == 1`, `paused == 0`),
* sends `crank_stake` / `crank_trade` when a cheap off-chain pre-filter
  says they're due — the program re-validates every condition and emits
  `NothingToDo` (a cheap success) when it isn't,
* pays its own fees; receives nothing; holds no user keys.

For mainnet trading, `AgentConfig.routeBuilder` is the integration point
for the Jupiter Swap API (quote → serialized route plan). The on-chain
output-floor check protects users regardless of router behaviour.

## Money flow summary

```
user SOL ──deposit──► position PDA (native) ──crank_stake──► Marinade reserve ──► mSOL ATA
user USDC ─deposit──► vault USDC ATA ──crank_trade(buy)──► burn+route ──► vault WSOL ATA
vault WSOL ATA ──crank_trade(sell)──► vault USDC ATA
any of the above ──withdraw_* (owner-signed ONLY)──► owner wallets
```

Nothing else can move. No fees are taken anywhere in v1 (a future
profit-share fee would be a config change — and will itself be audited).
