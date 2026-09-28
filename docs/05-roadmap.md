# 05 — Build Plan & Roadmap

**Today: 2026-09-22. Submission deadline: 2026-10-13, 11:59 PM ET
(2026-10-14 03:59 UTC) — 21 days from today, 22 counting today.**

> ✅ **Verified 2026-09-22** against the official hackathon pages: Metropolis
> runs Sep 1 – Oct 13 2026, judging Oct 14–27, winners announced Nov 3.
> Submissions are rolling and editable until the deadline; late submissions
> are not accepted.
>
> **Target track: 4 — Trust, Identity & AI Infrastructure** ($30,000). The
> track description names *"agent trust"* and *"agent reputation systems"*
> explicitly. AGENTX is a direct fit; Track 2 (Consumer Products & Payments)
> is the fallback if Track 4 is crowded.

---

> **This is the plan as written on 2026-09-22, kept as the plan.** Its
> checkboxes were never ticked and its dates are the original estimates —
> [`PROGRESS.md`](../PROGRESS.md) is the record of what actually happened, and
> the two are deliberately not the same document. Reality ran roughly a week
> ahead of these dates, and three things below turned out differently:
>
> - **No Redis.** Provisioned in M0, never wired to anything, removed 2026-09-28.
> - **No ESLint.** The script was declared but no config ever existed; removed
>   rather than left failing. TypeScript strict carries that weight.
> - **Contracts are not verified on the explorer.** An M1 done-condition that
>   is still open — it needs an explorer API key.

## 1. The strategy in one paragraph

Build the demo backwards. The thing being judged is one unbroken trace — a
user types one sentence and five real transactions settle on Monad. So the
vertical slice that produces that trace gets built first, end to end, ugly,
by Oct 2. Everything after that is making it correct, then making it look
good. A polished marketplace with no working hire is worth nothing; a working
hire with an ugly marketplace wins.

**Sequencing rule:** no milestone starts before the previous one's demo works.
If M2 slips, cut scope inside M4, never skip M3.

---

## 2. Milestone overview

| # | Milestone | Dates | Days | Ends when |
|---|---|---|---|---|
| M0 | Foundations | Sep 22 – Sep 24 | 3 | `pnpm dev` runs; a tx lands on Monad testnet from CI |
| M1 | Contracts | Sep 25 – Sep 28 | 4 | full job lifecycle passes invariant tests; deployed to testnet |
| M2 | Backend spine | Sep 29 – Oct 2 | 4 | a hire settles end-to-end via `curl`, no UI |
| M3 | Agents + MCP | Oct 3 – Oct 5 | 3 | orchestrator completes the two-step demo unattended |
| M4 | Frontend | Oct 6 – Oct 8 | 3 | marketplace + live job feed render real chain data |
| M5 | Harden + rehearse | Oct 9 – Oct 11 | 3 | demo survives the chaos checklist three runs in a row |
| M6 | Submit | Oct 12 – Oct 13 | 2 | video recorded, docs final, submission filed |

Days column sums to 22, counting both endpoints (Sep 22 and Oct 13 are both
working days). Two buffer days are already inside M5 and M6. **Do not spend
them early.**

---

## 3. M0 — Foundations · Sep 22–24

Goal: every developer can run the whole thing and ship to testnet.

- [ ] Three repos per [06 — Repository Structure](06-repo-structure.md)
- [x] `docker-compose.yml`: Postgres 16 ~~+ Redis 7~~ (Redis removed — nothing used it)
- [ ] Foundry project, `forge test` green on a hello-world contract
- [ ] **Chain reality check**: pull chain ID, RPC, explorer, faucet from
      current Monad docs; put them in `.env.example`; deploy and verify a
      trivial contract. *Do this on day one* — an unexpected faucet limit or
      verification quirk found on Oct 10 is fatal; found on Sep 22 it is an
      afternoon.
- [ ] `MockUSDC` deployed, minting to team wallets
- [x] CI: `forge test`, `forge coverage`, `tsc --noEmit` — **no `eslint`**, no config ever existed
- [ ] Shared zod schemas for `JobSpec` and `JobResult` in `packages/shared`

**Done when:** a fresh clone reaches a green `pnpm test` in under ten minutes,
and CI has verified a contract on the Monad explorer.

**Risk:** faucet rate limits. Mitigate by funding four wallets on day one, not
one wallet on demo day.

---

## 4. M1 — Contracts · Sep 25–28

Goal: the money layer is correct, because nothing after this can fix it.

**Sep 25** — 🔒 **M1-00b first**: vendor the ERC-8004 reference contracts and
**read the source** to confirm `giveFeedback()` accepts a *contract* caller.
Everything below assumes it does; if it does not, trigger the
[M1 fallback](../PLAN.md#m1-fallback-build-only-if-m1-00-fails) **today**, not
on Sep 27. Then deploy the reference registries to testnet (M1-00c — they are
[not deployed there](09-landscape.md#8-m1-00-verification--results-2026-09-22-on-chain)),
and build `StakeVault`: deposit, withdraw with delay, slash, `isHireable`,
with unit tests for each.

**Sep 26** — `TaskEscrow` happy paths: `createJob`, `acceptJob`,
`submitResult`, `approve`, `directPay`. Fee capture at creation. ERC-8004 read
adapter for wallet, price and capabilities.

**Sep 27** — `TaskEscrow` unhappy paths: `cancel`, `dispute`,
`resolveDispute`, and all three permissionless expiries. `giveFeedback()` on
settlement with `agentx`/`settled` tags and the job-binding `feedbackHash`.

**Sep 28** — `AgentAccount` + factory: policy caps, session keys, target and
selector allowlists. Invariants I1–I8. Deploy the full set to testnet, verify
every contract; the deploy script generates `deployments/10143.json`
([08 §4](08-configuration.md#4-deployments--deploymentschainidjson)).

**Done when:**
- [ ] 100% branch coverage on `TaskEscrow`
- [ ] invariants I1–I8 hold over 10,000 fuzz runs
- [ ] `forge snapshot` committed — gas cost per hire is a tracked number
- [ ] all contracts verified on the explorer with public source — **STILL OPEN**, needs `EXPLORER_API_KEY`
- [ ] a scripted lifecycle runs on testnet: register → hire → deliver → settle
      → score changes
- [ ] the param-drift test passes: every value in `config/params.10143.json`
      matches what is actually deployed
- [ ] `make deploy NETWORK=monad` is exercised against a **local fork of
      mainnet** — not deployed, but proven to work, so mainnet is a decision
      rather than a scramble

**Hard rule:** the ABI freezes on Sep 28. Everything downstream depends on it.
An ABI change on Oct 7 costs a day of re-wiring across four packages.

---

## 5. M2 — Backend spine · Sep 29 – Oct 2

Goal: a hire settles end to end with nothing but `curl`.

**Sep 29** — Drizzle migrations for the full schema in
[04 §4](04-how-it-works.md#4-database-schema). Seed script: 6 agents, ~300
historical settled jobs so reputation is non-trivial on sight.

**Sep 30** — Indexer: watch all four contracts, write `jobs`, `job_events`,
`payments`, `agent_stats`. Reorg handling via `last_block_hash`. Prove
idempotency by replaying the same block range twice and diffing the tables.

**Oct 1** — Signer service: policy pre-check, KMS signing, per-agent nonce
lock, idempotency keys, gas top-up with a floor.

**Oct 2** — Fastify API: agents CRUD, discovery with ranking, the full job
route set, SSE event stream, RFC 7807 errors, API-key auth.

**Done when:** this script passes unattended —

```bash
./scripts/e2e.sh
#  register two agents → hire one → deliver → approve → settle
#  asserts: worker balance +0.0198, fee +0.0002, score changed,
#           5 rows in job_events, every tx resolvable on the explorer
```

**Risk:** the indexer is the classic time sink. If it is not writing correct
rows by end of Oct 1, fall back to **optimistic writes + reconciliation**:
the API writes the expected row on broadcast and the indexer corrects it on
confirmation. Ugly, shippable, and invisible in a demo.

---

## 6. M3 — Agents + MCP · Oct 3–5

Goal: the demo runs itself. This is the milestone that wins or loses.

**Oct 3** — MCP server exposing the seven tools from
[04 §6](04-how-it-works.md#6-the-mcp-agent-interface). `@agentx/sdk` wrapping
the REST API for agents that prefer HTTP.

**Oct 4** — Worker agents: `research-bot`, `trading-bot`, `execution-bot`.
Each implements the accept/decline logic and self-validates output against
`outputSchema` before submitting.

**Oct 5** — Orchestrator: plan → discover → hire → await → validate →
approve → synthesise, with **every failure branch from
[04 §7.1](04-how-it-works.md#71-orchestrator-the-main-agent) implemented**:
no candidate found, budget exceeded, worker timeout, schema mismatch.

**Done when:**
- [ ] `pnpm demo` runs the two-step flow unattended, start to finish
- [ ] it prints every jobId, amount and explorer URL as it goes
- [ ] killing a worker mid-job produces a refund and a retry, not a hang
- [ ] a judge's own MCP client can call `discover_agents` and `hire_agent`

**Do not skip the failure branches to save a day.** Live demos fail on exactly
those paths, and an orchestrator that recovers gracefully in front of judges
is more convincing than one that never stumbles.

---

## 7. M4 — Frontend · Oct 6–8

Goal: make the invisible visible. Judges cannot see a tx trace; they can see a
dashboard.

**Oct 6** — Marketplace grid: agent cards with capability tags, price, score,
completed count, success rate. Filters and the four ranking modes.

**Oct 7** — Agent profile (job history, earnings, score over time) and the
register-an-agent flow with wagmi/RainbowKit.

**Oct 8** — **The live demo view.** One page, one input box, and a real-time
column of events streaming in over SSE as the agents transact:

```
┌──────────────────────────────────────────────────────────────┐
│  "Find the best opportunity for me."            [ Run ]      │
├──────────────────────────────────────────────────────────────┤
│  ● MAIN AGENT      planning… 2 subtasks                      │
│  ● DISCOVER        market-research → 3 candidates            │
│  ● HIRE            ResearchBot · 0.02 USDC · direct   0xab… ↗│
│  ● RESULT          "ETH/USDC depth: …"                       │
│  ● HIRE            ExecutionBot · 0.05 USDC · escrow  0xcd… ↗│
│  ● SETTLED         paid 0.0495 · fee 0.0005 · score 96→96  ↗ │
├──────────────────────────────────────────────────────────────┤
│  Total spent 0.07 USDC   ·   5 txs   ·   2 agents hired      │
└──────────────────────────────────────────────────────────────┘
```

Every `↗` is a live explorer link. That page **is** the submission video.

**Done when:** a stranger watching the screen can explain what happened
without narration.

---

## 8. M5 — Harden and rehearse · Oct 9–11

**Oct 9 — chaos day.** Run the checklist and fix what breaks:

- [ ] kill the worker process mid-job → refund fires, orchestrator retries
- [ ] kill the indexer for 60s → it catches up, no duplicate rows
- [ ] hit the daily spending cap → clean 402, orchestrator degrades gracefully
- [ ] submit a malformed result → dispute path, not a crash
- [ ] RPC returns 500 for 30s → retry with backoff, no stuck job
- [ ] run the demo on a phone hotspot → no timeout assumptions baked in
- [ ] agent wallet runs out of MON → clear error, auto top-up recovers

**Oct 10 — security pass.** Re-read [04 §9](04-how-it-works.md#9-security-model-and-threats)
against the actual code. Confirm: no key in logs or env, SSRF guard on
`metadataURI` fetches, `nonReentrant` on every state-changing function,
rate limits live, idempotency enforced on every money POST. Fix or explicitly
document each gap.

**Oct 11 — rehearsal.** Run the full demo three times back to back on the real
testnet with the real UI. Time it. If it is over three minutes, cut a subtask.
Record a **backup video** on this day, while there is still time to fix what it
exposes.

**Done when:** three consecutive clean runs, and a backup video exists.

---

## 9. M6 — Submit · Oct 12–13

**Oct 12**
- [ ] README: one-paragraph pitch, architecture diagram, contract addresses
      with explorer links, 5-minute quickstart
- [ ] Final docs pass — including the honest limitations from
      [04 §9.3](04-how-it-works.md#93-what-is-explicitly-not-solved)
- [ ] Deck: problem → solution → demo → architecture → why Monad → what's next
- [ ] Record the real demo video, 2–3 minutes, no dead air

**Oct 13**
- [ ] Submit with buffer — **hours, not minutes**
- [ ] Verify every link in the submission from a logged-out browser
- [ ] Freeze `main`; any further work goes on a branch

**Submission checklist**

| Item | Why judges care |
|---|---|
| Live demo URL | they will click it, and it must work cold |
| Video ≤ 3 min | most judging happens here |
| Verified contracts with source | proves it is real, not mocked |
| Explorer links to demo txs | independently checkable |
| Honest limitations section | reads as engineering maturity, not weakness |
| "Why Monad", sourced | cite current Monad docs; no invented numbers |

---

## 10. The cut list

Decide now what dies under time pressure, so the decision is not made at 3am
on Oct 12. Cut strictly from the bottom.

| Priority | Feature | Status |
|---|---|---|
| **P0** — never cut | register, discover, hire, deliver, settle, reputation | the thesis |
| **P0** | orchestrator running the demo unattended | the proof |
| **P0** | live demo page | the evidence |
| P1 | escrow path (direct-pay alone still demos) | keep if M1 is on time |
| P1 | on-chain `AgentAccount` policy caps | strong differentiator; keep |
| P2 | dispute + arbiter resolution | cut to a documented design if Oct 9 is tight |
| P2 | agent profile page | mergeable into the marketplace card |
| P3 | staking UI | CLI is fine; seed the stakes |
| P3 | score-over-time chart | decoration |
| P3 | four ranking modes | ship `balanced` only |

---

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Testnet instability on demo day | medium | fatal | backup video from Oct 11; local anvil fork as fallback narration |
| Faucet limits block funding | medium | high | fund 4 wallets during M0; never depend on demo-day funding |
| Indexer eats three days | medium | high | optimistic-write fallback, decided Oct 1 not Oct 8 |
| ABI churn after Sep 28 | medium | high | hard freeze; changes require a written reason |
| Orchestrator non-determinism (LLM) | high | medium | constrain with tools + schemas; temperature 0; cache the demo plan |
| Scope creep into "agent framework" | high | high | the cut list; AGENTX is rails, not a framework |
| One person owns all keys and is ill on Oct 13 | low | fatal | two people hold deploy access; deployment is one documented command |

The last row is the one nobody writes down and the one that actually ends
hackathon runs.

---

## 12. Beyond the hackathon

| Phase | Window | Focus |
|---|---|---|
| **v0.2 — Trust** | 4–6 weeks | optimistic verification with a challenge window and staked challengers; replace the multisig arbiter |
| **v0.3 — Scale** | 6–10 weeks | per-epoch netting so N subtasks settle in one transaction; the real answer to machine-rate transaction volume |
| **v0.4 — Open network** | 10–16 weeks | permissionless agent onboarding, public SDK, capability taxonomy, streaming/subscription pricing |
| **v0.5 — Interop** | 16+ weeks | multi-chain settlement, fiat on-ramp for agent wallets, enterprise spending policies and audit export |

The single most valuable follow-up is **v0.2**. Everything in this design
rests on verification, and the MVP verifies schema conformance rather than
truth. Solving that honestly — optimistic, staked, challengeable — is what
turns a hackathon project into infrastructure.

---

## 13. Daily rhythm

- **Morning, 10 min:** what shipped yesterday, what ships today, what is blocked.
- **Evening:** `main` is green and deployable. No exceptions — a broken `main`
  on a 21-day project costs more than the feature that broke it.
- **Every day from Oct 3:** run `pnpm demo` once. The day it stops working is
  the day you fix it, not the day you discover it.
