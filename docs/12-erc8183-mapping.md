# 12 — `TaskEscrow` against ERC-8183, function by function

> **Status:** analysis only. No contract was changed or redeployed for this
> document, and none will be before the deadline. The deployed contracts back
> every piece of live evidence in this repository (settlement hashes, the
> keeper refunds, the AgentAccount refusals); redeploying to chase a Draft
> standard would throw that evidence away for a claim of conformance to text
> that is still moving.
>
> Written 2026-09-30 from the specification itself, not a summary of it:
> [`ERCS/erc-8183.md`](https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8183.md)
> (Draft, created 2026-02-25; requires ERC-20;
> [discussion](https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902)).
> [09 §10.2](09-landscape.md#102-erc-8183-agentic-commerce--convergent-and-it-changes-the-pitch)
> is the positioning; this is the detail underneath it.

## 1. Read this first: the spec disagrees with itself

ERC-8183's normative text gives functions in prose (`fund(jobId,
expectedBudget, optParams?)`), and exact Solidity only in its reference
contract, `AgenticCommerce.sol`. The two differ on at least eight points:

- whether `fund` takes `expectedBudget` (the prose's front-running protection);
- who may call `setBudget`;
- whether `setProvider` takes `optParams` and is hookable;
- hook data encoding (the reference prepends `msg.sender`);
- whether `submit` works from Open with a zero budget;
- whether a zero budget is allowed at all;
- an evaluator fee that exists only in the reference;
- a `hook` field that the reference's `JobCreated` has and the prose's does not.

**This mapping follows the prose**, because that is what the standard says an
implementation SHALL do. Where it matters, the reference behaviour is noted.
The spec defines no ERC-165 interface id for the core contract (only
`IACPHook` has one), so there is no mechanical conformance check to pass or
fail. "Conforms" here means "implements the prose surface and its transitions".

## 2. The shape: same kernel, different trust model

| | ERC-8183 | `TaskEscrow` |
|---|---|---|
| Parties | `client`, `provider`, `evaluator` — **addresses** | client and worker — **ERC-8004 agent ids**, resolved to wallets through the identity registry on every call |
| Who judges | the `evaluator`, final: "no dispute resolution or arbitration; reject/expire is final" | the client approves or disputes; an `ARBITER_ROLE` resolves disputes |
| Silence after delivery | evaluator never acts → `claimRefund` at expiry → **client refunded** | client never acts → `autoApprove` after the review window → **worker paid** |
| States | Open, Funded, Submitted, Completed, Rejected, Expired | CREATED, ACCEPTED, SUBMITTED, DISPUTED, SETTLED, REFUNDED |
| Funding | separate `fund` step after Open | at creation: `createJob` escrows in the same transaction |
| Reputation | optional ERC-8004 extension, written by hooks | core: only the escrow writes AGENTX feedback, only on settlement |
| Fast path | none — every job is escrowed | `directPay` below `fastPathMax` |
| Fee | optional platform fee in bps, "deducted only on completion (not on refund)" | protocol fee in bps, captured at creation, taken only on settlement; refunds are whole |
| Meta-transactions | ERC-2771 "SHOULD" | none; the agent's `AgentAccount` and session keys play that role |

The row that matters is **silence after delivery**. The two standards make
opposite bets about who goes quiet. ERC-8183 protects the client from an
evaluator that never shows up; `TaskEscrow` protects the worker from a client
that takes the result and stops answering. Neither is wrong. They are
different products, and a mapping that hid this would be misleading.

## 3. Functions

| ERC-8183 (prose) | Caller | `TaskEscrow` | Notes |
|---|---|---|---|
| `createJob(provider, evaluator, expiredAt, description, hook?)` | client | `createJob(clientAgentId, workerAgentId, amount, specHash, acceptWindow, workWindow)` | Ids, not addresses. `description` → `specHash`, a commitment to the canonical spec plus the job's id (the text stays off chain). One `expiredAt` → two deadlines. `evaluator` is implicitly the client, which the spec allows ("if 'client completes', pass `evaluator = client`"). No hook. |
| `setProvider(jobId, provider, optParams?)` | client | — | The worker is fixed at creation. ERC-8183 lets a job be posted with no provider; AGENTX hires a named agent. |
| `setBudget(jobId, amount, optParams?)` | client or provider (reference: provider only) | — | The price is the worker's registered price, and is fixed at creation. |
| `fund(jobId, expectedBudget, optParams?)` | client | *folded into* `createJob` | Open and Funded collapse into CREATED. Front-running on the budget cannot happen because budget and funding are one call. |
| — | worker | `acceptJob(jobId)` | **No ERC-8183 equivalent.** The provider's commitment is its own state (ACCEPTED), which starts the work clock and lets an unaccepted job be cancelled or expired cheaply. |
| `submit(jobId, deliverable, optParams?)` | provider | `submitResult(jobId, resultHash, resultURI)` | Same idea. AGENTX also stores a URI, and starts the review window. |
| `complete(jobId, reason?, optParams?)` | evaluator | `approve(jobId)` (client), `autoApprove(jobId)` (anyone, after review) | No `reason`. `autoApprove` has no counterpart — see §2. |
| `reject(jobId, reason?, optParams?)` when Open | client | `cancel(jobId)` in CREATED | Refund, no outcome recorded against the worker. |
| `reject(...)` when Funded/Submitted | evaluator | `dispute(jobId, reasonHash)` → `resolveDispute(jobId, false)` | The client cannot reject a delivery unilaterally. A rejection is an arbiter's decision, and is recorded as a lost dispute. |
| — | arbiter | `resolveDispute(jobId, true)` | **No ERC-8183 equivalent:** a rejection that can be overturned. |
| `claimRefund(jobId)` | anyone, after `expiredAt` | `expireUnaccepted(jobId)` (CREATED), `expireUndelivered(jobId)` (ACCEPTED) | One exit per non-terminal state rather than one for all. Both are permissionless, both refund in full, neither can be blocked, matching the spec's "`claimRefund` SHALL NOT be hookable". |
| — | client | `directPay(...)` | The fast path, and what an [x402 payment](04-how-it-works.md) settles as. No equivalent. |
| `getJob` (reference only) | anyone | `getJob(jobId)` | |

## 4. States

```
ERC-8183     Open ──fund──▶ Funded ──submit──▶ Submitted ──complete──▶ Completed
               │               │                  │  └────reject──────▶ Rejected
               └─reject─▶ Rejected  └─claimRefund─┴──claimRefund──────▶ Expired

TaskEscrow   CREATED ──acceptJob──▶ ACCEPTED ──submitResult──▶ SUBMITTED ──approve / autoApprove──▶ SETTLED
               │                       │                          └──dispute──▶ DISPUTED ──resolveDispute──▶ SETTLED | REFUNDED
               ├─cancel / expireUnaccepted──▶ REFUNDED
               └─────────────── expireUndelivered (from ACCEPTED) ─────────────▶ REFUNDED
```

| ERC-8183 | `TaskEscrow` |
|---|---|
| Open | — (no unfunded state) |
| Funded | CREATED, and ACCEPTED |
| Submitted | SUBMITTED |
| Completed | SETTLED (outcome SUCCESS) |
| Rejected | REFUNDED after `cancel`, or after a lost dispute |
| Expired | REFUNDED after `expireUnaccepted` / `expireUndelivered` |
| — | DISPUTED |

## 5. Events

| ERC-8183 (reference signature) | `TaskEscrow` |
|---|---|
| `JobCreated(jobId, client, provider, evaluator, expiredAt, hook)` + `JobFunded(jobId, client, amount)` | `JobCreated(jobId, clientAgentId, workerAgentId, amount, fee, specHash, acceptDeadline)` — one event, because it is one step |
| `ProviderSet`, `BudgetSet` | — |
| `JobSubmitted(jobId, provider, deliverable)` | `ResultSubmitted(jobId, resultHash, resultURI)`, preceded by `JobAccepted(jobId, workDeadline)` |
| `JobCompleted(jobId, evaluator, reason)` + `PaymentReleased(jobId, provider, amount)` | `JobSettled(jobId, paid, fee, outcome)` |
| `JobRejected(jobId, rejector, reason)` | `JobDisputed(jobId, reasonHash)` → `DisputeResolved(jobId, false)` → `JobRefunded` |
| `JobExpired(jobId)` + `Refunded(jobId, client, amount)` | `JobRefunded(jobId, amount, reason)`; `reason` is `unaccepted`, `undelivered`, `cancelled` or `dispute` |
| — | `DirectPaid`, `FeedbackFailed` |

## 6. Gaps — both ways

**What ERC-8183 has that `TaskEscrow` does not**

- Jobs posted without a provider, and negotiated budgets (`setProvider`, `setBudget`).
- Evaluators other than the client: a contract checking a ZK proof, a panel.
- Hooks (`IACPHook.beforeAction` / `afterAction`), and ERC-2771 meta-transactions.

**What `TaskEscrow` has that ERC-8183 leaves out** (the spec's own words:
"no dispute resolution or arbitration", "use reputation (e.g. ERC-8004) or
staking for high-value jobs")

- Disputes with an arbiter who can overturn a rejection.
- Staking (`StakeVault`) as a hireability condition.
- Reputation written only by the escrow, only on settlement — the defence
  against [unpaid feedback](09-landscape.md#101-the-empirical-case-for-agentx-is-now-published-with-numbers).
- A fast path, and x402 settlement on top of it.
- Spending caps, on chain, in the paying agent's own wallet (`AgentAccount`).

**A gap ERC-8183's design principle exposed — closed in v2.** ERC-8183 has
no disputes, but insists that funded money always has a permissionless way
out (`claimRefund`). v1's `TaskEscrow` kept that promise for CREATED,
ACCEPTED and SUBMITTED and broke it for DISPUTED. v2 (deployed 2026-09-30)
adds `expireDispute`: after the dispute timeout anyone may settle for the
worker, with no review either way — proven live on testnet.

## 7. What conformance would look like

A wrapper cannot do this. `TaskEscrow` checks `msg.sender` against the agent's
registered wallet, so a wrapper contract calling it would be refused as
`NotAgentWallet`. Making the wrapper every agent's wallet would give it every
agent's money. Conformance means a new kernel.

The design that keeps AGENTX's properties **inside** ERC-8183, not beside it:

1. **An ERC-8183 kernel, as written.** Open → Funded → Submitted → Completed /
   Rejected / Expired, `claimRefund` unhookable, following the prose where it
   disagrees with the reference.
2. **AGENTX as the evaluator** — a contract, which the spec explicitly allows.
   It holds the review window and the dispute process. It calls `complete`
   when the client approves or the window lapses, and `complete` or `reject`
   on the arbiter's ruling. That restores `autoApprove`'s protection for the
   worker without changing the kernel.
3. **AGENTX as the hook** (`IACPHook`):
   - `beforeAction(fund)` refuses an unbonded provider (`StakeVault`).
   - `afterAction(complete | reject)` writes ERC-8004 feedback. This is the
     spec's recommended extension, and the hook stays the only writer, so
     reputation stays settlement-backed.
   - The spec's gas-limit and "MUST NOT modify core escrow state" rules apply
     unchanged.
4. **`directPay` stays outside**, as its own function on its own contract. A
   fast path is not an escrow, and forcing it through Open → Funded →
   Submitted would cost three transactions for a payment the design says
   should cost one.
5. **Caps are untouched.** They live in the client's `AgentAccount`, which
   calls `fund` like any other client. ERC-8183 does not need to know.

Two things are lost in that design: agent ids as the addressing unit, where
the kernel uses addresses (the evaluator and hook resolve ids themselves), and
the ACCEPTED state. An ERC-8183 provider is committed from the moment it is
set, so an unaccepted job becomes "funded, never submitted", which only
expiry resolves.

## 8. Decision

**Not before 2026-10-13.** The standard is Draft and inconsistent with its
own reference (§1), the live evidence depends on the deployed contracts, and
the design in §7 is a new kernel plus two contracts, not an adapter. It is the
first post-hackathon contract item, alongside the DISPUTED timeout (§6), which
should ship in the same deployment.
