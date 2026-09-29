# 01 — Core Idea

**AGENTX — proof-of-payment reputation and escrow for ERC-8004 agents,
settled on Monad.**

ERC-8004 gives agents a verifiable identity and a place to record reputation.
It does not give them money — and because its feedback is free to write,
that reputation is manipulable. AGENTX is the settlement layer that makes
ERC-8004 reputation cost something: agents discover, hire, escrow, verify and
pay each other, and **only a settled on-chain payment can write a review**.

Tagline: *Agents that can work — and pay each other.*

> **Positioning was revised 2026-09-22** after surveying the landscape. The
> original framing — a standalone agent marketplace with its own identity and
> reputation registries — duplicated ERC-8004 (already deployed on Monad) and
> Virtuals ACP (already live on Base). See
> [09 — Landscape Analysis](09-landscape.md) for the evidence and the
> resulting architecture changes.

---

## 1. The problem

An AI agent today can reason, call APIs, search, write code, and analyse data.
What it cannot do is participate in an economy.

When an agent needs work it cannot do itself, there is no native primitive for:

```
find a capable counterparty
  → agree a price
  → pay
  → receive the result
  → verify it
  → settle
```

Every one of those steps currently falls back to a human: a human signs up for
the API, a human puts in a card, a human approves the charge, a human checks
the output. The agent stalls at the point where money has to move.

Three specific gaps — and as of late 2026, only one of them is still open:

| Gap | Status |
|---|---|
| **Identity** | ✅ **Solved.** ERC-8004's Identity Registry is deployed on Monad. Agents are ERC-721 tokens with an agent card. |
| **Settlement** | ❌ **Open.** ERC-8004 has no payment primitive at all. Nothing in the standard moves money. |
| **Trust** | ⚠️ **Broken.** ERC-8004 has a Reputation Registry, but `giveFeedback()` is callable by anyone. An [empirical study](https://arxiv.org/abs/2606.26028) of the live ecosystem found coordinated sybil registrations and reputation manipulation, because **feedback is not tied to any transaction**. |

AGENTX closes the second and fixes the third, and deliberately does not touch
the first.

## 2. The solution

AGENTX is on-chain infrastructure with four primitives.

### 2.1 Agent identity

Every agent has an ERC-8004 identity on-chain (an owner and a payout wallet)
and a bond in `StakeVault`. Its capability tags and price are held off-chain
in AGENTX's catalogue, where discovery can search them. Nothing is written to
ERC-8004 metadata today.

```
ResearchBot
  owner        0xA1…9f
  wallet       0x4c…b2
  capabilities market-research, data-analysis
  price        0.02 USDC / task
  stake        50 USDC
  reputation   94
  completed    1,284 tasks
```

The stake is what makes the identity cost something. Sybil agents are cheap to
create only if identity is free.

### 2.2 Agent-to-agent payments

Agent A pays Agent B directly, with no human in the approval path:

```
Agent A ──── 0.02 USDC ───▶ Agent B
```

Unattended does not mean unbounded. The design puts each agent's funds in an
`AgentAccount` with a spending policy (per-task cap, daily cap, counterparty
allowlist) that the contract enforces, not only the application.

> **As built (2026-09-29):** the demo's orchestrator — the only agent that
> spends — pays through an `AgentAccount`. Its owner (the deployer in the
> demo, standing in for a human; on a real deployment it would be the human's
> own key) creates it through `AgentAccountFactory` with caps of 0.1 MockUSDC
> per task and 1 per day, allowlists only `TaskEscrow` and its five client
> functions, funds it, and grants the signer's hot key a session key that
> expires within a day. The signer sends every call to the account as
> `execute(target, data)`, and the **contract** enforces the caps. Run live on
> testnet, 3/3 steps settled and the account's `spentToday` read 0.13
> MockUSDC. Holding that session key, a 0.2 hire reverts
> `PerTaskCapExceeded`, sending the USDC anywhere else reverts
> `TargetNotAllowed`, and granting itself an allowance reverts `NotOwner`.
>
> The three workers never spend and still use plain EOAs. For an EOA the caps
> are the agent's row in `spend_policies` (seeded from per-chain
> `defaultPerTaskCap` / `defaultDailyCap`), and the **signer** enforces them:
> it checks and reserves the amount in one `UPDATE` under the per-agent lock,
> over a rolling 24-hour window, and an agent with no policy row can spend
> nothing. That is application code, not the contract.

### 2.3 Escrow

For work worth more than the fee to escrow it, funds are locked until the job
resolves:

```
        Agent A
           │ deposit
           ▼
     ┌───────────┐   result accepted    ┌─────────┐
     │  ESCROW   │─────────────────────▶│ Agent B │
     └───────────┘                      └─────────┘
           │ rejected / expired
           ▼
        Agent A
```

Below a configurable threshold, jobs take a **direct-pay fast path** instead:
paying is cheaper than protecting the payment. Above it, escrow. Cheap is not
enough on its own: the fast path pays before any work is done, so `auto` takes
it only when the worker's score is at least `fastPathMinScore` (70 on
testnet). A new agent starts at 50, so it is always hired through escrow until
it has a record. A client may still ask for `path: 'direct'` explicitly.

### 2.4 Reputation — proof-of-payment

**This is the differentiator.** Feedback is written to the *standard*
ERC-8004 Reputation Registry, but only by the escrow contract, and only when
money has actually moved on-chain. A settlement writes 100. A refund after the
worker accepted and did not deliver, or after the worker lost a dispute,
writes 0. A cancelled job or one that was never accepted writes nothing.

On the direct-pay fast path, the 100 is written **in the payment
transaction**, before the work is delivered. The fast path trades the
protection of escrow for one transaction, and that includes the review.

> **Testnet caveat.** ERC-8004 is deployed on Monad mainnet but **not on
> testnet** (verified 2026-09-22). On testnet, where the demo runs, AGENTX
> deploys its own minimal registries (`MockIdentityRegistry`,
> `MockReputationRegistry`). They reproduce the two behaviours the design
> depends on: self-feedback is rejected and `getSummary` reverts on an empty
> client list. Mainnet points the same code at the canonical `0x8004…`
> registries.

ERC-8004's read function takes a filter — `getSummary(agentId,
clientAddresses, tag1, tag2)` — so a reader chooses whose feedback to count:

```solidity
// Reverts: "clientAddresses required" — an unfiltered score does not exist.
getSummary(agentId, [], "", "")

// Counts only feedback written by the escrow, after a settled payment.
getSummary(agentId, [AGENTX_ESCROW], "agentx", "settled")
```

Verified against the reference implementation 2026-09-22: `getSummary`
**reverts on an empty client list**. ERC-8004 therefore already forces every
reader to name whose feedback they count — it just never gave them an address
worth naming. One address filter turns the registry into an economically-secured
score.
AGENTX does not fork the standard or ask anyone to migrate — it becomes the
feedback source worth filtering for, and any ERC-8004 reader adopts it with a
one-line change.

Each feedback carries
`feedbackHash = keccak256(jobId, specHash, resultHash, amount)`, so anyone can
recompute it from public chain state and confirm the review corresponds to a
real settled payment.

```
completed   1,284
failed         81
disputed        7
volume     25.68 USDC
score          94
```

(Those numbers are internally consistent: 1,284 × 0.02 USDC = 25.68, and the
scoring formula in [04 §2.3](04-how-it-works.md#23-reputationregistry) maps
1284/81 to exactly 94.)

As built, the indexer computes these counters from `TaskEscrow`'s own
`JobSettled` and `JobRefunded` events, the same transactions that write the
ERC-8004 feedback. It does not read them back from the registry. The
`disputed` counter is not maintained yet.

A hiring agent then optimises over price **and** score **and** success rate
**and** capability match — not just the cheapest bid.

## 3. What changes

Before:

```
Human → AI → Human approves → Transaction
```

After:

```
Agent → discover → hire → pay → receive → verify → settle → continue
```

The agent stops being a tool that recommends a purchase and becomes an actor
that makes one.

## 4. Why Monad

The honest framing is about transaction *shape*, not marketing adjectives.

Agent work produces many small, unattended, machine-to-machine payments. One
orchestrator running ten subtasks produces ten payments and ten settlements.
The interesting regime is thousands of agents doing that continuously — a
workload of high-frequency, low-value transfers that must stay cheap enough
that a 0.02 USDC task is not dominated by its own settlement cost.

AGENTX uses Monad as its settlement layer and is designed around that
workload: a direct-pay path for micro-jobs (one transaction) and on-chain
state kept deliberately small. Batched settlement is **not built**. Today
every job settles on its own, and per-epoch netting is the named v2 scaling
path ([04 §11](04-how-it-works.md#11-open-questions)).

> Keep performance claims sourced. Cite current Monad documentation for any
> throughput or finality numbers in the submission; do not assert them from
> memory. Note that Monad mainnet is **live** (chain ID 143, verified
> 2026-09-22) — do not write copy that reads as though the chain were still
> pre-launch.

## 5. What AGENTX is not

- ❌ an AI chatbot
- ❌ an AI trading bot
- ❌ a DEX
- ❌ an NFT marketplace
- ❌ another generic agent framework
- ❌ **a competitor to ERC-8004** — it is a settlement layer *for* it
- ❌ **a new reputation standard** — it writes to the existing one

It is **economic infrastructure for autonomous agents**: escrow, settlement,
and on-chain spending policy, feeding reputation into a standard that already
exists and is already deployed on Monad mainnet.

Honest competitive positioning — claim this much and no more — is in
[09 §6](09-landscape.md#6-honest-competitive-positioning). The space is
crowded (Virtuals ACP, x402, AP2, Skyfire, Nevermined); a judge will know it,
and specificity beats superlatives.

## 6. The demo that proves it

One human instruction; everything after it is agents transacting.

```
USER  "Research ETH/USDC liquidity on Monad and tell me whether to open a position."
          │
          ▼
    MAIN AGENT ── plans subtasks from the capabilities actually on offer
          │
          ▼
    RESEARCH AGENT     escrow 0.02 USDC → accept → research → result
          │               → judged by the main agent → approve → release
          ▼
    TRADING AGENT      escrow 0.05 USDC → accept → analyse → result
          │               → judged by the main agent → approve → release
          ▼
    (EXECUTION AGENT   escrow 0.06 USDC, if the plan calls for it)
          │
          ▼
        MONAD    ✓ payments  ✓ escrow  ✓ settlement  ✓ reputation
```

This is what `pnpm demo` runs (`scripts/demo.mjs`). The planner decides how
many of the three workers to hire, so a run may use two or three. Prices
straddle the testnet `fastPathMax` of 0.03 USDC, but the demo's agents are
registered fresh each run with a score of 50, below `fastPathMinScore` (70), so
**every step goes through escrow**; the fast path is not exercised by the demo.
It has run end to end on Monad testnet with a local model (Ollama `llama3` 8B,
`BRAIN_CHAIN=ollama` and `BRAIN_CHAIN_ORCHESTRATOR=ollama`), and a cached
replay (`AGENT_MODE=cached`) reproduces a recorded run with no model. Every
payment, accept, submit and approve is a real testnet transaction with an
explorer link. The demo fails if any step ends `failed` or `timeout`.
`DEMO_CHAOS=no-accept` or `DEMO_CHAOS=mid-job` adds a fourth, cheaper,
deliberately broken worker to show the orchestrator giving up on it and hiring
another.

## 7. MVP scope

In scope for the hackathon:

1. Register an agent (identity, capabilities, price, stake).
2. Browse/query the marketplace by capability, price, and score.
3. Hire an agent — direct pay for micro-jobs, escrow above the threshold.
4. Deliver a result and settle.
5. Reputation updates automatically from settlement.
6. An orchestrator agent that does 1–5 with no human in the loop.

For item 1, `POST /v1/agents` takes the agent's ERC-8004 id as
`chainAgentId`, and the API checks it on chain before storing it: the id must
exist, be owned by `ownerAddress`, and pay out to `walletAddress`. If the API
cannot read the registry it refuses rather than trusts. The `/register` page
reads the id from the registration's `Registered` event and passes it. (Until
2026-09-29 nothing set this id, so an agent registered through the UI or the
API could not be hired; only the demo worked, because its scripts wrote the
column with SQL.)

Out of scope, deliberately: cryptographic result verification, staking
slashing games, cross-chain, agent-to-agent negotiation of price, a token.

## 8. Where it goes

The same rails serve coding agents, research agents, trading agents, data
agents, commerce agents, DeFi agents, API-wrapper agents — any autonomous
service that can be paid per unit of work.
