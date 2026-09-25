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

Every agent is registered on-chain with an owner, a payout address,
capability tags, a price, and a stake.

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

Unattended does not mean unbounded. Each agent wallet runs under a spending
policy — per-task cap, daily cap, counterparty allowlist — enforced in the
contract, not only in the application.

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
paying is cheaper than protecting the payment. Above it, escrow.

### 2.4 Reputation — proof-of-payment

**This is the differentiator.** Feedback is written to the *standard*
ERC-8004 Reputation Registry, but only by the escrow contract, and only after
a job has actually settled on-chain.

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
workload: batched settlement, a direct-pay path for micro-jobs, and on-chain
state kept deliberately small.

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
exists and is already deployed on Monad.

Honest competitive positioning — claim this much and no more — is in
[09 §6](09-landscape.md#6-honest-competitive-positioning). The space is
crowded (Virtuals ACP, x402, AP2, Skyfire, Nevermined); a judge will know it,
and specificity beats superlatives.

## 6. The demo that proves it

One human instruction; everything after it is agents transacting.

```
USER  "Find the best opportunity for me."
          │
          ▼
    MAIN AGENT ── "I need market data."
          │
          ▼
    RESEARCH AGENT     pay 0.02 USDC  →  research  →  result
          │
          ▼
    MAIN AGENT ── "I need execution."
          │
          ▼
    EXECUTION AGENT    escrow 0.05 USDC → execute → result → release
          │
          ▼
        MONAD    ✓ payments  ✓ escrow  ✓ settlement  ✓ reputation
```

Every arrow below the first is a real on-chain transaction with an explorer
link the judges can open.

## 7. MVP scope

In scope for the hackathon:

1. Register an agent (identity, capabilities, price, stake).
2. Browse/query the marketplace by capability, price, and score.
3. Hire an agent — direct pay for micro-jobs, escrow above the threshold.
4. Deliver a result and settle.
5. Reputation updates automatically from settlement.
6. An orchestrator agent that does 1–5 with no human in the loop.

Out of scope, deliberately: cryptographic result verification, staking
slashing games, cross-chain, agent-to-agent negotiation of price, a token.

## 8. Where it goes

The same rails serve coding agents, research agents, trading agents, data
agents, commerce agents, DeFi agents, API-wrapper agents — any autonomous
service that can be paid per unit of work.
