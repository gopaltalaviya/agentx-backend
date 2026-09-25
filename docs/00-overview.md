# AGENTX

**Proof-of-payment reputation and escrow for ERC-8004 agents, on Monad.**

ERC-8004 gives agents a verifiable identity and a place to record reputation.
It does not give them money — and because `giveFeedback()` is callable by
anyone, that reputation is free to forge. AGENTX is the settlement layer that
makes it cost something: **only a settled on-chain payment can write a review.**

```solidity
// ERC-8004 REQUIRES you to name whose feedback you count.
// getSummary reverts on an empty client list — there is no "overall score".
getSummary(agentId, [AGENTX_ESCROW], "agentx", "settled")   // backed by real money
```

The standard already forces every reader to name their sources. What it does
not give them is **an address worth naming**. AGENTX is that address.

> *Agents that can work — and pay each other.*

```
USER  "Find the best opportunity for me."
   │
   ▼
MAIN AGENT ──▶ RESEARCH AGENT    0.02 USDC  (direct pay)
   │
   └────────▶ EXECUTION AGENT    0.05 USDC  (escrow → verify → release)
   │
   ▼
MONAD    ✓ payments   ✓ escrow   ✓ settlement   ✓ reputation
```

One human sentence in. Every payment after it is one agent paying another.

---

## Working files — read these first

| File | Purpose |
|---|---|
| **[PROGRESS.md](../PROGRESS.md)** | **Start every session here.** Current state, next actions, blockers, config, session log |
| [PLAN.md](../PLAN.md) | ~119 tasks across 7 milestones, with owners and dependencies |
| [docs/07 — What I Need From You](07-what-i-need-from-you.md) | The checklist of accounts, facts and decisions only you can supply |

## Specification

| Doc | What it covers |
|---|---|
| [01 — Core Idea](01-idea.md) | The problem, the four primitives, MVP scope, why Monad |
| [02 — Flow Charts](02-flowcharts.md) | System map, hire-to-settle sequence, job state machine, discovery, reputation |
| [03 — Technology Stack](03-tech-stack.md) | Every technology and why, chain config, local dev |
| [04 — How It All Works](04-how-it-works.md) | Contract interfaces, wallet architecture, DB schema, API spec, MCP tools, agent workflow, security model |
| [10 — LLM Architecture](10-llm-architecture.md) | Agent-to-agent prompt injection, why schema-valid is not correct, prompt caching, evals, failure taxonomy |
| [05 — Build Plan & Roadmap](05-roadmap.md) | 21-day milestone plan, cut list, risk register, post-hackathon roadmap |
| [06 — Repository Structure](06-repo-structure.md) | The 3-repo split, how ABIs and types cross boundaries, conventions |
| [08 — Configuration Architecture](08-configuration.md) | Single source of truth: chain registry, protocol params, generated deployments, env split, multi-chain data model |
| **[09 — Landscape Analysis](09-landscape.md)** | **Read before writing contract code.** ERC-8004, x402, AP2, Virtuals ACP; what not to build; honest competitive positioning |

Start with **01**, then **02** for the shape of the system, then **04** when
you are ready to write code.

## Repositories

Three, deliberately. Contracts never enter a hosting provider's build
container. See [docs/06](06-repo-structure.md).

```
agentx-contracts    Foundry only     deployed manually by the key holder
agentx-backend      pnpm monorepo    → Railway (api, indexer, signer, mcp, agents)
agentx-interface    Next.js only     → Vercel
```

---

## What we build vs. what we integrate

| Integrate — already deployed on Monad | Build — nothing else has these |
|---|---|
| ERC-8004 **Identity Registry** `0x8004A169…a432` | **`TaskEscrow`** — job state machine, deadlines with permissionless exits, sole writer of settlement-backed feedback |
| ERC-8004 **Reputation Registry** `0x8004BAa1…9b63` | **`AgentAccount`** — spending caps enforced *on-chain*, not on someone's server |
| ERC-8004 Validation Registry *(coming soon)* | **`StakeVault`** — the custody ERC-8004 lacks; makes listings cost something |

Two contracts from the original design were **deleted** rather than built.
See [docs/09](09-landscape.md).

## Status

**Live on Monad testnet.** 2026-09-24, 19 days to the deadline.

| | |
|---|---|
| Contracts | 120 tests, deployed and settling — `TaskEscrow` [`0x1b0959…027c`](https://testnet.monadexplorer.com/address/0x1b0959dfd32323e5a4749d5444c2e6435349027c) |
| Backend | 175 tests — API, signer, indexer, MCP server, orchestrator, three worker bots |
| Interface | live demo page, marketplace, agent profile, register — builds clean |

**The one blocker:** `pnpm demo` has never run, because it needs a model and
`agentx-backend/.env` does not exist. A free `GEMINI_API_KEY` or
`GROQ_API_KEY` unblocks it. That gates M3's done-condition, the three
remaining chaos items, and the backup video.

**Also outstanding:** the interface has not been opened in a browser; Railway
and Vercel are not deployed; the arbiter and fee recipient still default to
the deployer.

**Networks:** ships on **Monad testnet (10143)**, with **mainnet (143)
supported by the same code**. The network is configuration, never a code
path — see [docs/08](08-configuration.md).

**Hackathon:** Monad Metropolis, submissions due **2026-10-13, 11:59 PM ET**.
Target track: **4 — Trust, Identity & AI Infrastructure** ($30,000), whose
description explicitly names *agent trust* and *agent reputation systems*.

## What this is not

Not a chatbot, not a trading bot, not a DEX, not an NFT marketplace, not
another agent framework. It is the payment and trust rail those things would
run on.
