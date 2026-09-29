# 09 — Landscape Analysis & Required Changes

**Researched 2026-09-22.** Read this before writing a line of contract code.

The short version: **two of the five contracts in
[04 §2](04-how-it-works.md#2-smart-contracts) should not be written.** The
standard they would reinvent is already deployed on Monad. What is *not*
solved — and what a published study says is actively broken — is exactly the
part AGENTX is good at.

---

## 1. What exists now

| Thing | What it is | Status | Overlaps AGENTX? |
|---|---|---|---|
| **ERC-8004** *Trustless Agents* | Draft EIP. Three registries: Identity (ERC-721), Reputation, Validation | **Deployed on Monad**, Identity `0x8004A169…a432`, Reputation `0x8004BAa1…9b63`; Validation "coming soon" | **Yes — Agent identity + reputation, entirely** |
| **x402** | HTTP 402 payment protocol. Server answers 402, agent pays USDC, retries with a receipt header | Linux Foundation as of Apr 2026. ~165M tx, ~$50M volume, ~69k active agents. Live on Base + Solana | Partially — pay-per-request, **no escrow, no multi-step jobs** |
| **AP2** (Google) | Intent / Cart / Payment Mandates as W3C Verifiable Credentials. Proves a *human* authorised a purchase | 60+ partners. x402 is its crypto extension | No — it is authorisation, not settlement |
| **Virtuals ACP** | On-chain agent marketplace: discover, hire, escrow, evaluate. On Base | Live | **Yes — this is the AGENTX flow, shipped** |
| **Skyfire / Nevermined / Coinbase Agentic Wallets** | Agent wallets with spend controls, metering, fiat+crypto rails | Live, funded | Partially — spend control, but **off-chain and custodial** |

### The uncomfortable conclusion

The AGENTX concept as originally specced — register an agent, browse a
marketplace, hire, escrow, settle, build reputation — **is Virtuals ACP**, and
its identity and reputation layers **are ERC-8004**, which Monad already hosts
and documents.

Shipping that unchanged means competing on execution with a live product,
while reinventing a standard that the target track is explicitly about. In
Track 4 — *Trust, Identity & AI Infrastructure* — a judge who knows ERC-8004
will notice within thirty seconds.

That is a good problem to find on day one rather than on Oct 12.

---

## 2. The gap that is actually open

ERC-8004 gives agents **identity** and a place to **record feedback**. It does
not give them **money**. There is no escrow, no settlement, no payment
primitive anywhere in the standard.

And its reputation layer has a documented weakness. From *"Can Trustless
Agents Be Trusted? An Empirical Study of the ERC-8004 Decentralized AI Agent
Ecosystem"* (arXiv 2606.26028), the findings are:

| Finding | What it means |
|---|---|
| **Sybil behaviour** — coordinated duplicate registrations | Identity is free, so identities are disposable |
| **Reputation manipulation** — scores "lack robust verification", collusion possible | `giveFeedback()` can be called by any address. Feedback is **not tied to a transaction** |
| **Dormant registries** — many agents with zero transaction history | Registration proves nothing about capability |
| **Payment gaps** — "incomplete payment settlement mechanisms" | The standard has no payments at all |
| **Validation gaps** — no verification that agents have claimed skills | Capability claims are self-asserted |

Read the two middle rows together and the opportunity is explicit: **ERC-8004
reputation is unfalsifiable because feedback is free to write.** Anyone can
praise anyone. Nothing binds a review to work actually done and paid for.

---

## 3. The repositioning

> **ERC-8004 gives agents identity and a place to record reputation.
> It does not give them money, and its feedback is free to forge.
> AGENTX is the settlement layer that makes ERC-8004 reputation cost something.**

Concretely, AGENTX issues **proof-of-payment feedback**: it calls
`giveFeedback()` only from the escrow contract, only after a job has actually
settled on-chain.

The mechanism that makes this work is already in the standard. ERC-8004's

```solidity
getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2)
```

lets a reader **choose whose feedback to count**. So:

```solidity
// REVERTS with "clientAddresses required" — there is no unfiltered score
getSummary(agentId, [], "", "")

// only feedback backed by a settled, on-chain AGENTX payment
getSummary(agentId, [AGENTX_ESCROW], "agentx", "settled")
```

Confirmed by reading the reference implementation: naming your sources is
**mandatory**. The standard built the filter and left the hard part — being
a source worth filtering for — to someone else.

One address filter turns an open feedback registry into an
economically-secured one. AGENTX does not fork the standard, compete with it,
or ask anyone to migrate — it becomes **the reputation source worth filtering
for**, and every other ERC-8004 reader can adopt it with a one-line change.

That is a far better story than another marketplace, and it is defensible in
front of a judge who knows the space.

### The new one-liner

> **AGENTX — proof-of-payment reputation and escrow for ERC-8004 agents,
> settled on Monad.**

Tagline stays: *Agents that can work — and pay each other.*

---

## 4. Required architecture changes

### 4.1 Delete two contracts

| Was | Becomes |
|---|---|
| `AgentRegistry.sol` | **ERC-8004 Identity Registry** at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. Price and capabilities go in `setMetadata()`; the agent card carries the rest |
| `ReputationRegistry.sol` | **ERC-8004 Reputation Registry** at `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, written via `giveFeedback()` from escrow only |

This removes roughly **a day and a half of M1**, which pays for everything
added below.

### 4.2 Add one small contract

ERC-8004 has no custody, so staking needs somewhere to live:

```solidity
contract StakeVault {
    // agentId (ERC-8004) → bonded amount
    function deposit(uint256 agentId, uint96 amount) external;
    function requestWithdraw(uint256 agentId, uint96 amount) external;  // starts cooldown
    function withdraw(uint256 agentId) external;                        // after WITHDRAW_DELAY
    function slash(uint256 agentId, uint96 amount, bytes32 reason) external; // SLASHER_ROLE
    function bondOf(uint256 agentId) external view returns (uint96);
    function isHireable(uint256 agentId) external view returns (bool);   // bond >= minStake
}
```

Directly addresses the paper's **sybil** and **dormant registry** findings:
identity stays free and open as the standard intends, but *being hireable
through AGENTX* costs a bond with a withdrawal delay.

### 4.3 Keep, unchanged — this is the real product

`TaskEscrow` and `AgentAccount` survive intact. They are the parts nothing
else in the landscape has:

- **`TaskEscrow`** — job state machine, deadlines with permissionless exits,
  dispute path, and the sole writer of settlement-backed feedback.
- **`AgentAccount`** — spending caps enforced **on-chain**. Skyfire, Nevermined
  and Coinbase Agentic Wallets all do spend control, but off-chain and
  custodially; you trust their server. An on-chain per-task and daily cap with
  a counterparty allowlist is verifiable by anyone and survives a compromise of
  our own signer. This is the strongest purely-technical differentiator in the
  project. As of Sep 29 it is in the payment path: the demo's orchestrator,
  the only agent that spends, pays through an `AgentAccount` capped at 0.1
  MockUSDC per task and 1 per day, allowlisted to the escrow alone, with the
  signer holding only a session key. Called as a compromised signer with that
  key, a 0.2 hire reverted `PerTaskCapExceeded`, a transfer out reverted
  `TargetNotAllowed`, and self-granting an allowance reverted `NotOwner`. The
  three workers, which never spend, are still EOAs whose caps the signer
  enforces off-chain, and in the demo the account's owner is the deployer key
  standing in for a human's.

### 4.4 Add the x402 bridge

x402 is the payment standard with actual adoption, and it is not on Monad.
ERC-8004's agent card even has an `x402Support` boolean.

Two pieces, both small:

1. **Facilitator endpoint** — `POST /v1/x402/verify` and `/settle`, so any
   x402 client can pay a Monad-hosted AGENTX agent.
2. **402 responses** — worker agent endpoints answer `402 Payment Required`
   with AGENTX payment details, then accept the retry with a receipt header.

Under the hood, an x402 payment is just `directPay` on the fast path. The
work is an adapter, not a second payment system.

> **Cut first if time runs out.** This is P2 — the ERC-8004 integration is what
> the track is about; x402 is the reach.

### 4.5 Validation Registry — stretch only

Monad lists it as "coming soon". If it lands before Oct 8, AGENTX registers as
a validator and calls `validationResponse()` after schema-checking a result,
which addresses the paper's **validation gap** finding. Do not build against a
contract that does not exist yet; check on Oct 6 and take it only if free.

---

## 5. What this does to the demo

The trace barely changes, but what it *proves* changes completely:

```
USER  "Find the best opportunity for me."
   │
   ▼
MAIN AGENT
   │  discover via ERC-8004 Identity Registry (already live on Monad)
   │  rank by getSummary(agentId, [AGENTX_ESCROW])  ← settlement-backed only
   ▼
RESEARCH AGENT    0.02 USDC  direct pay once proven (score ≥ 70); escrow before that
   │
   ▼  result verified → escrow calls giveFeedback() → ERC-8004 reputation
EXECUTION AGENT   0.05 USDC  escrow → verify → release → giveFeedback()
   │
   ▼
MONAD    ✓ standard identity  ✓ payments  ✓ escrow  ✓ proof-of-payment reputation
```

The line that lands in the video: *"That reputation score cannot be faked,
because writing it costs a settled on-chain payment."*

And a judge can verify it independently — the feedback is in a public registry
they already know, at an address Monad documents.

---

## 6. Honest competitive positioning

For the submission write-up. Claim exactly this much and no more:

| Versus | AGENTX's actual claim |
|---|---|
| **ERC-8004** | Not a competitor. AGENTX is a *feedback source* and settlement layer for it, and fixes its documented reputation-manipulation weakness |
| **Virtuals ACP** | Same flow, different bet: ACP is a closed marketplace on Base; AGENTX is standards-native on Monad, and its reputation is portable to any ERC-8004 reader |
| **x402** | Complementary. x402 is pay-per-request; AGENTX adds escrow and multi-step jobs. We bridge to it rather than compete |
| **AP2** | Orthogonal — human authorisation, not agent-to-agent settlement |
| **Skyfire / Nevermined / Coinbase** | Their spend controls are off-chain and custodial. AGENTX's are on-chain and verifiable |

**Do not claim** to be first, only, or fastest. The landscape is crowded and a
judge will know it. Claim the specific gap — *settlement-backed reputation for
an existing standard* — and let the specificity do the work.

---

## 7. Net effect on the plan

| Change | Effort |
|---|---|
| Delete `AgentRegistry.sol` + tests | **−1 day** |
| Delete `ReputationRegistry.sol` + tests | **−0.5 day** |
| Integrate ERC-8004 Identity (read, register, metadata) | +0.5 day |
| `giveFeedback()` from escrow, with tags | +0.5 day |
| `StakeVault.sol` + tests | +0.5 day |
| Agent-card generation + hosting | +0.5 day |
| x402 facilitator adapter (P2) | +1 day |
| **Net** | **≈ breakeven, or −0.5 day if x402 is cut** |

Better positioning, less contract code, a live standard to point at, and a
published paper describing the exact problem being solved. The trade is
strongly favourable.

---

## 8. M1-00 verification — results (2026-09-22, on-chain)

Probed both registries directly over JSON-RPC. Verified facts:

| Check | Result |
|---|---|
| Monad testnet chain ID | `0x279f` = **10143** ✅ matches config |
| Monad mainnet chain ID | `0x8f` = **143** ✅ matches config |
| Identity Registry on **mainnet** | ✅ live — ERC-721, `name() = "AgentIdentity"`, `symbol() = "AGENT"` |
| Reputation Registry on **mainnet** | ✅ live — contract code present |
| Identity Registry on **testnet** | ❌ **`eth_getCode` returns `0x` — no contract** |
| Reputation Registry on **testnet** | ❌ **no contract** |
| Contract type | **ERC-1967 upgradeable proxies.** Identity implementation: `0x7274e874ca62410a93bd8bf61c69d8045e399c02` |

### 8.1 The conflict this creates

Two decisions that were each fine alone are incompatible as written:

- *"Ship on testnet first"* ([08](08-configuration.md))
- *"Integrate ERC-8004"* (this document)

**ERC-8004 is not deployed on Monad testnet.** The registries exist only on
mainnet. Monad's own guide does not say which network it describes — the
addresses are mainnet.

### 8.2 Resolution — deploy the reference implementation to testnet

Keep both decisions. The ERC-8004 contracts are open source
([`erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts)),
so we deploy them ourselves on testnet and use the canonical deployment on
mainnet:

| Chain | Identity + Reputation registries |
|---|---|
| 10143 testnet | **we deploy** the reference implementation |
| 143 mainnet | the canonical `0x8004…` addresses |

The configuration architecture already supports this without a code change:
the per-chain `external` block in `deployments/<chainId>.json`
([08 §4](08-configuration.md#4-deployments--deploymentschainidjson)) holds the
registry addresses, and nothing in the codebase hardcodes them. Testnet gets
our addresses, mainnet gets the canonical ones, identical code either way.

Cost: **+0.5 day** in M1 to vendor, deploy and verify two contracts we do not
have to write. Against the alternative — demoing on mainnet with real money —
it is not close.

**Bonus:** because we control the testnet deployment, `SeedDemo.s.sol` can
register six agents with real settled history, which the mainnet registries
would never have let us fabricate.

### 8.3 M1-00b — resolved 2026-09-22 ✅

Read from the reference implementation,
[`erc-8004/erc-8004-contracts@master`](https://github.com/erc-8004/erc-8004-contracts)
(note: the default branch is `master`, not `main`).

**`giveFeedback` is plain `external`.** No `tx.origin` check, no `isContract`
guard, no EOA restriction. **A contract can call it**, and feedback is stored
under `_feedback[agentId][msg.sender][idx]` — so `TaskEscrow`'s own address
becomes the client address `getSummary` filters on. *The differentiator is
viable exactly as designed.*

Three things came with that answer:

| Finding | Consequence |
|---|---|
| `require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed")` | `TaskEscrow` must never own or be an approved operator of an agent it rates. New threat **T17** in [04 §9.2](04-how-it-works.md#92-threat-table) |
| `MAX_ABS_VALUE = 1e38` | Bounds `value`. Our 0–100 scale is far inside it |
| `getSummary` reverts on an empty `clientAddresses` list | **There is no unfiltered ERC-8004 score.** Naming your sources is mandatory — which strengthens the positioning, and corrected four documents that claimed otherwise |

And one scaling limit: `getSummary` loops over every feedback entry per client.
AGENTX is a single client address, so the loop grows with an agent's job count
and will exceed RPC gas caps. The score is therefore computed by the indexer
from `NewFeedback` events; `getSummary` is kept for spot-checks.

### 8.4 Still unverified
- **The registries are upgradeable proxies.** Their ABI can change under us.
  Pin the implementation address seen at integration time and add a CI check
  that it has not moved. Worth one honest line in the submission's trust
  assumptions.

If `giveFeedback()` turns out to be EOA-only, fall back to the custom
contracts specced in [04 §2.1 / §2.3](04-how-it-works.md#21-agentregistry).

---

## 10. Landscape refresh — 2026-09-28

Six days after the original analysis. Two findings, one that strengthens the
thesis considerably and one that changes how the project must be positioned.

### 10.1 The empirical case for AGENTX is now published, with numbers

*"Can Trustless Agents Be Trusted? An Empirical Study of the ERC-8004
Decentralized AI Agent Ecosystem"*, Xiong et al., 2026
([arxiv 2606.26028](https://arxiv.org/html/2606.26028)).

The study measured the live ERC-8004 ecosystem. Its findings are the problem
statement of this project, quantified:

| Finding | Number |
|---|---|
| Median cost to manipulate an agent's score | **$0.0027** on Base, $0.0042 BSC, $0.055 Ethereum |
| Reviewers flagged as Sybil | **90.6%** Base, 73.5% Ethereum, 59.2% BSC |
| Rated agents left with *no valid feedback* once Sybil reviews are removed | **77.9% – 86.8%** |
| Feedback records carrying neither payment proof nor task linkage | **98.7% – 100%** |
| Base reviewers who have never made an x402 payment | **93.8%** |

Feedback is free because the standard "require[s] no proof of interaction" and
any non-owner account may submit a rating.

**Their recommended mitigations, next to what AGENTX already does:**

| Paper recommends | AGENTX |
|---|---|
| "Require evidence-backed interactions (payment proofs or validated tasks)" | `TaskEscrow` is the **sole writer** of AGENTX feedback, and only after a settlement |
| "Attach stakes/costs to feedback proportional to value controlled" | `StakeVault` — a listing costs a bond keyed to the ERC-8004 agent id |
| "Per-funder caps, stake requirements" | Per-task and daily caps: on-chain by `AgentAccount` for the demo's spending agent (the orchestrator); enforced by the signer for EOA agents (the workers) |
| "Median or trimmed-mean aggregation instead of arithmetic mean" | ⬜ **not done** — scoring is Laplace-smoothed and volume-damped, which resists a single lucky job but not a coordinated ring. Worth stating as a limitation rather than claiming otherwise |

This is independent third-party evidence that the design is the right one, and
it is the strongest line available for the submission:

> 98.7% of ERC-8004 feedback has no payment behind it, and moving an agent's
> score costs about a third of a cent. AGENTX makes a review cost exactly what
> the job cost, because only the escrow can write one.

### 10.2 ERC-8183 Agentic Commerce — convergent, and it changes the pitch

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) (Draft, created
2026-02-25), from Virtuals Protocol and the Ethereum Foundation's dAI team,
standardises **the job-escrow layer this project also built.**

It specifies a Job with states Open → Funded → Submitted →
Completed/Rejected/Expired, ERC-20 escrow with an optional platform fee in
basis points, and a permissionless `claimRefund()` after expiry. That is
substantially `TaskEscrow`'s shape, arrived at independently.

**This must be said plainly in the submission rather than discovered by a
judge.** "We built an escrow that writes ERC-8004 reputation" is a weaker
claim in September 2026 than it was in August. What survives scrutiny is the
set of things ERC-8183 deliberately leaves out — verified against the spec
text, not a summary:

| | ERC-8183 | AGENTX |
|---|---|---|
| Agent spending caps | **not specified** | Per-task + daily caps, on-chain via `AgentAccount` for the demo orchestrator (the only agent that spends); signer-enforced for EOA agents |
| Staking / bonding | **not specified** | `StakeVault`, bond per agent id |
| Dispute resolution | **not specified** — the evaluator is final | `dispute()` → arbiter, and the review window |
| Micro-payment fast path | **not specified** — every job uses full escrow | `directPay` below `fastPathMax` |
| Permissionless exits | one (`claimRefund` after expiry) | three, one per non-terminal state |
| ERC-8004 reputation | **optional extension**, written by client-supplied hooks | core: only the escrow writes, only on settlement |

The last row is the important one. ERC-8183's own security note says the
evaluator "is trusted for completion and rejection" and that "malicious
evaluators can complete/reject arbitrarily — reputation systems recommended
for high-value jobs." **That recommendation is the gap AGENTX fills**, and
§10.1 is the evidence that reputation systems which are not payment-backed do
not fill it.

### 10.3 What this changes

1. **Positioning.** AGENTX is not "an escrow for agents". It is
   *settlement-backed reputation*, plus the bounds an autonomous spender needs
   — caps, stake, disputes — on top of an escrow whose shape the ecosystem is
   now standardising. Complementary to ERC-8183, not competing with it.
2. **Say it first.** The submission should name ERC-8183 and explain the
   relationship. A judge who knows the standard and finds no mention of it
   will assume we did not.
3. **Post-hackathon, not now.** Mapping `TaskEscrow` onto the ACP `Job`
   interface is the obvious next step and is explicitly **out of scope** with
   15 days left and the demo not yet run end to end. Recorded as roadmap.
4. **One honest limitation to add** to the "not solved" list: scoring uses a
   damped mean, not a trimmed mean, so a coordinated ring of settled jobs
   between colluding agents would still move a score — it just has to pay full
   price for every review, which is the point.

### 10.4 Unchanged since 2026-09-22

- ERC-8004 is still **Draft**; the EF dAI team has it on the 2026 roadmap.
- The Monad registries and the pinned implementation address are as recorded
  in §8. `make verify-erc8004` is the check that they have not moved.

