# How to get Cypher audited — including for free

Honest framing first: **a professional human audit with a signed report
costs money** (typically tens of thousands of USD from a named firm).
What follows is the ladder this repo is already set up for — start free,
escalate only as the value at risk grows. Everything in steps 0–3 costs
$0 and is ready to run today.

## Step 0 — already done in this repo (free, reproducible)

An auditor's first week of work is already mechanised here:

* `cargo test -p cypher --lib` — 17 unit/property/**fuzz** tests,
  including deterministic fuzzers that proved the parser can never panic
  (they found and fixed one real bug: truncated-`Partial` slice panic).
* `cargo clippy --workspace --all-targets -- -D warnings` — zero warnings.
* `anchor test` — 21-test executable specification of every guard.
* `fuzz/` — libFuzzer harnesses for coverage-guided deep fuzzing.
* `python3 scripts/verify_mainnet.py` — machine-verified external
  constants (Marinade IDL layouts + PDAs, immutable Jupiter v6, Pyth
  receiver) — the #1 source of real-world Solana exploits is wrong CPI
  wiring, and it is checked here from the chain itself.
* `AUDIT_CHECKLIST.md` — zero open items; `SECURITY.md` — threat model
  with testable invariants.

Run all of it in CI (already wired: `.github/workflows/ci.yml`).

## Step 1 — free automated tools (run today)

```bash
cargo install cargo-audit cargo-deny
cargo audit                       # known CVEs in the dependency tree
cargo deny check                  # license/advisory/ban policy
cargo +nightly fuzz run fuzz_parse_price_update -- -max_total_time=1800
cargo +nightly fuzz run fuzz_math             -- -max_total_time=1800
```

(Solana programs don't run under Slither/Echidna — those are EVM tools.
For Anchor, the constraint system + the fuzzers above are the equivalent
surface.)

## Step 2 — free human review (this week, $0)

1. **Publish the repo** (you are doing this) with
   `SECURITY.md` + private vulnerability reporting enabled
   (GitHub → Settings → Code security → Private vulnerability reporting).
2. **Ask for review where Solana auditors hang out**, pointing at
   `AUDIT_CHECKLIST.md` and `docs/MAINNET_VERIFICATION.md` as the review
   brief:
   * Solana Tech / Anchor channels (Solana Discord `#anchor`,
     `#security`), Solana StackExchange (`solana.stackexchange.com` —
     tag `anchor`, post the CPI-layout differential as a question).
   * Security research Discords (e.g. Sec3/Soteria community channels,
     OtterSec's public channels) — post the repo, not the ask.
3. **Offer public credit** in the README ("reviewed by @handle") — this
   is real currency for junior auditors building a portfolio, and
   contest-placing researchers do repo reviews for visibility.
4. **Retroactive public goods**: once live, a small retro funding round
   (Gitcoin-style) can pay community reviewers.

## Step 3 — free-to-list bug bounty ($0 to list)

* **Immunefi** (immunefi.com) — the standard venue; listing is free,
  Immunefi takes a 10% fee only on paid bounties. The bounty table is
  already written in `SECURITY.md` (paste it into the listing form).
  You can start with a modest pool and raise it with TVL.
* **Sherlock bounties / Cantina bounties** — same model, Solana coverage.
* A live bounty turns the whole whitehat market into your auditor, which
  is the strongest *continuous* free coverage that exists.

## Step 4 — cheap human review (hundreds, not tens of thousands)

* **Audit contests** (best coverage per dollar as of 2026):
  Sherlock, Cantina, CodeHawks. You fund the prize pool; dozens of
  researchers compete. Code4rena — historically the biggest — is
  winding down (its homepage says so as of Nov 2026), so prefer the
  other three. A small pool (~$5–20k) on ~2.5k SLOC like this program
  buys a week of full attention.
* **Short scoped reviews**: several firms/indies sell fixed-price
  3–5-day reviews of one module — the exact fit here is
  `programs/cypher/src/**` (small by design).

## Step 5 — grants & subsidies (free if awarded)

* **Solana Foundation** — open-source ecosystem tools are grant-eligible;
  security work for a non-custodial public-good program is a strong case.
  Apply via solana.org grants with this repo + audit checklist as the
  scope document.
* **Ecosystem retro funds / delegations** — Solana aggregator/LST teams
  have co-funded integration audits (an integration audit of THIS
  program is also a due-diligence review for them — ask Marinade's and
  Jupiter's ecosystem teams; they want correct integrations).

## Step 6 — when you must pay for the named-firm audit

Trigger points: TVL meaningfully above your bounty pool, or a third
party (exchange, LST team, DAO) requires a signed report. Firms with
Solana/Anchor track record: OtterSec, Neodyme, Zellic, Kudelski, Ackee,
Certus, Trail of Bits (Anchor-experienced teams). Budget 3–6 weeks lead
time; hand them exactly the "Suggested audit scope" in
`AUDIT_CHECKLIST.md` + the repro pack in `docs/MAINNET_VERIFICATION.md`
— the prep in this repo typically cuts 1–2 weeks off their calendar.

## What free review can never replace

Automated tools find bugs you can describe; contests find bugs many eyes
compete to describe; a signed audit adds *accountability* — a firm that
put its name on a review of a specific commit. Until step 6 is done,
keep TVL small, keep the bounds conservative, keep the freeze script
unexecuted-but-ready, and keep the bounty live.

---

*Market notes above reflect public pages checked 2026-11 (Immunefi
bounty index; Sherlock/Cantina product pages; Code4rena wind-down
notice).*
