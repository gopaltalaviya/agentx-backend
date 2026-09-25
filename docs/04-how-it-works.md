# 04 — How It All Works (full technical detail)

The complete specification: architecture, smart-contract interfaces, database
schema, API surface, agent workflow, wallet architecture, and security model.

Contents:

1. [Architecture](#1-architecture)
2. [Smart contracts](#2-smart-contracts)
3. [Wallet architecture](#3-wallet-architecture)
4. [Database schema](#4-database-schema)
5. [API specification](#5-api-specification)
6. [The MCP agent interface](#6-the-mcp-agent-interface)
7. [Agent workflow](#7-agent-workflow)
8. [Money: fees, decimals, accounting](#8-money-fees-decimals-accounting)
9. [Security model and threats](#9-security-model-and-threats)
10. [Testing strategy](#10-testing-strategy)
11. [Open questions](#11-open-questions)

---

## 1. Architecture

### 1.1 The split

The single most important design decision is what lives on-chain.

**On-chain (trust-critical, minimal):**
- who an agent is and who owns it
- how much is staked
- how much is locked for which job
- the outcome of each job and the hash of its result
- the counters reputation is derived from
- spending limits on agent wallets

**Off-chain (everything else):**
- job descriptions and result payloads
- capability text, search indexes, ranking
- analytics, timelines, the UI
- LLM calls and the actual work

Rule of thumb: *if a dishonest party could profit by lying about it, it goes
on-chain.* A job description cannot be profitably lied about once its hash is
committed. A payment amount can. So the hash goes on-chain and the text does not.

### 1.2 Services

| Service | Responsibility | Never does |
|---|---|---|
| `api` | HTTP/SSE surface, auth, validation, job orchestration | hold private keys |
| `signer` | policy check + sign + broadcast + nonce management | accept unauthenticated calls |
| `indexer` | chain events → Postgres, reorg-safe | write anything the chain did not say |
| `mcp` | agent-facing tool surface over `api` | contain business logic of its own |
| `web` | marketplace, profiles, live job feed | talk to the chain for writes |
| `agents/*` | do the actual work | share a wallet with another agent |

Data flows one way: **chain → indexer → database → API → clients.** The API
never invents on-chain state; it reads what the indexer recorded. This is why
the UI can never show a payment that did not happen.

### 1.3 Request path for a hire

```
agent → MCP tool call
      → api: validate spec, resolve agent, check caller budget
      → signer: check policy, sign createJob(), broadcast
      → chain: funds locked, JobCreated emitted
      → indexer: writes jobs row + job_events row
      → api: SSE push to client agent
      → queue: offer dispatched to worker agent
```

The API responds to the caller as soon as the transaction is *broadcast*, with
status `pending` and the tx hash, then pushes `confirmed` over SSE. Agents get
a fast acknowledgement without the system lying about finality.

---

## 2. Smart contracts

> ⚠️ **Revised 2026-09-22 by [09 — Landscape Analysis](09-landscape.md).**
> `AgentRegistry` and `ReputationRegistry` are **not built**. ERC-8004's
> Identity and Reputation registries are already deployed on Monad and are used
> instead. `StakeVault` is added for the custody ERC-8004 lacks. The sections
> below are kept as the **fallback design**, to be built only if the
> verification steps in [09 §7](09-landscape.md#7-net-effect-on-the-plan) fail.

Three contracts of our own, plus two we integrate with. Solidity 0.8.26,
OpenZeppelin 5.x.

```
  ERC-8004 Identity Registry            (deployed: 0x8004A169…a432)
  0x8004…  ERC-721 agentId, agentURI, metadata, agentWallet
        ▲                    ▲
        │ read               │ read
        │                    │
  StakeVault            TaskEscrow ──────▶ ERC-8004 Reputation Registry
  bond per agentId          │   giveFeedback()   (deployed: 0x8004BAa1…9b63)
        ▲                   │                    tags: "agentx" / "settled"
        │                   └──▶ IERC20 (payment token)
        │
  AgentAccount ──▶ (calls TaskEscrow within its on-chain spending policy)
        ▲
  AgentAccountFactory
```

**What we build:** `TaskEscrow`, `AgentAccount` + factory, `StakeVault`.
**What we integrate:** ERC-8004 Identity and Reputation.
**Why:** identity and reputation are a solved, deployed standard; escrow,
settlement and on-chain spending policy are not.

### 2.0 ERC-8004 integration (the live path)

Identity and reputation come from the registries already deployed on Monad.
Full rationale in [09](09-landscape.md).

```solidity
interface IIdentityRegistry {                    // 0x8004A169…a432 — ERC-721
    function register(string calldata agentURI, MetadataEntry[] calldata m)
        external returns (uint256 agentId);
    function setAgentURI(uint256 agentId, string calldata newURI) external;
    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external;
    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory);
    function getAgentWallet(uint256 agentId) external view returns (address);
    function ownerOf(uint256 agentId) external view returns (address);   // ERC-721
}

interface IReputationRegistry {                  // 0x8004BAa1…9b63
    function giveFeedback(
        uint256 agentId, int128 value, uint8 valueDecimals,
        string calldata tag1, string calldata tag2, string calldata endpoint,
        string calldata feedbackURI, bytes32 feedbackHash
    ) external;

    function getSummary(
        uint256 agentId, address[] calldata clientAddresses,
        string calldata tag1, string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}
```

**How AGENTX uses them**

| Need | Mechanism |
|---|---|
| Agent identity | `agentId` = the ERC-8004 ERC-721 token id. AGENTX mints nothing. |
| Owner | `ownerOf(agentId)` |
| Payout address | `getAgentWallet(agentId)` — the `AgentAccount` |
| Price | `setMetadata(agentId, "agentx:pricePerTask", abi.encode(uint96))` |
| Capabilities | `skills[]` in the agent card, mirrored to `"agentx:capabilities"` |
| Stake | `StakeVault.bondOf(agentId)` — ERC-8004 has no custody |
| Reputation **write** | `TaskEscrow` calls `giveFeedback()` **only after settlement** |
| Reputation **read** | `getSummary(agentId, [address(taskEscrow)], "agentx", "settled")` |

**The one idea that matters.** `giveFeedback()` is callable by anyone, which
is precisely why the empirical study found ERC-8004 reputation manipulable.
`getSummary()` takes a `clientAddresses` filter, and — verified against the
reference implementation 2026-09-22 — that filter is **mandatory**: an empty
list reverts with `"clientAddresses required"`. There is no such thing as an
agent's overall ERC-8004 score.

So the standard already forces every reader to name whose feedback they count.
What it never supplied is an address worth naming. AGENTX writes feedback
**only from the escrow contract, only after a job settles on-chain**, so
filtering to `[taskEscrow]` yields a score that cannot be written without
spending money.

**Two constraints from the reference implementation**, both load-bearing:

1. `require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed")`.
   `TaskEscrow` must never be the owner or an approved operator of an agent it
   rates. See threat **T17**.
2. `MAX_ABS_VALUE = 1e38` bounds `value`. Our 0–100 scale is far inside it.

```solidity
// inside TaskEscrow._settle(), after funds have moved
reputation.giveFeedback({
    agentId:       workerAgentId,
    value:         outcome == Outcome.SUCCESS ? int128(100) : int128(0),
    valueDecimals: 0,
    tag1:          "agentx",
    tag2:          "settled",
    endpoint:      "",
    feedbackURI:   "",                 // job receipt, optional
    feedbackHash:  keccak256(abi.encode(jobId, specHash, resultHash, amount))
});
```

`feedbackHash` binds the feedback to the exact job, spec, result and amount.
Anyone can recompute it from public chain state and confirm the review
corresponds to a real settled payment.

**Score derivation.** The smoothed, volume-damped formula in
[§2.3](#23-reputationregistry) still applies — computed off-chain in
`@agentx/config` from the `count` and `summaryValue` returned by
`getSummary()`, rather than from our own storage. Same maths, standard source.

**Verify before committing** (M1, by Sep 28): read the deployed registries
directly and confirm the ABIs match this draft EIP, and that `giveFeedback()`
accepts a contract caller. If either fails, build §2.1 and §2.3 below instead.

---

### 2.0b `StakeVault`

The custody ERC-8004 does not provide. Bonds are what make a listing cost
something, addressing the sybil and dormant-registration findings in
[09 §2](09-landscape.md#2-the-gap-that-is-actually-open).

```solidity
function deposit(uint256 agentId, uint96 amount) external;
function requestWithdraw(uint256 agentId, uint96 amount) external;  // starts cooldown
function withdraw(uint256 agentId) external;                        // after WITHDRAW_DELAY
function slash(uint256 agentId, uint96 amount, bytes32 reason) external;  // SLASHER_ROLE
function bondOf(uint256 agentId) external view returns (uint96);
function isHireable(uint256 agentId) external view returns (bool);   // bond >= minStake
```

Only `ownerOf(agentId)` may withdraw. The withdrawal delay is what stops an
agent taking a large job and pulling its bond in the same block.

---

### 2.1 `AgentRegistry`

> **Fallback only** — not built unless the ERC-8004 verification in M1-00
> fails. See [§2.0](#20-erc-8004-integration-the-live-path).

Identity and discovery anchor.

```solidity
struct Agent {
    // slot 0 — address(20) + uint96(12) = 32 bytes exactly
    address owner;          // human or DAO that controls the agent
    uint96  pricePerTask;   // in payment-token base units
    // slot 1 — address(20) + uint96(12) = 32 bytes exactly
    address wallet;         // AgentAccount that pays and gets paid
    uint96  stake;          // slashable bond, >= MIN_STAKE to be listed
    // slot 2 — 8 + 1 = 9 bytes
    uint64  registeredAt;
    bool    active;
    // slot 3
    bytes32 capabilitiesRoot;  // merkle root of capability tags
    // slot 4+
    string  metadataURI;       // JSON: name, description, tags, endpoint
}

event AgentRegistered(uint256 indexed agentId, address indexed owner, address wallet);
event AgentUpdated(uint256 indexed agentId, uint96 price, string metadataURI);
event AgentDeactivated(uint256 indexed agentId);
event StakeDeposited(uint256 indexed agentId, uint96 amount);
event StakeWithdrawn(uint256 indexed agentId, uint96 amount);
event AgentSlashed(uint256 indexed agentId, uint96 amount, bytes32 reason);

function register(
    address wallet,
    uint96  pricePerTask,
    bytes32 capabilitiesRoot,
    string calldata metadataURI,
    uint96  stakeAmount
) external returns (uint256 agentId);

function updateAgent(uint256 agentId, uint96 price, bytes32 capsRoot, string calldata uri) external;
function setActive(uint256 agentId, bool active) external;
function depositStake(uint256 agentId, uint96 amount) external;
function requestWithdraw(uint256 agentId, uint96 amount) external;   // starts cooldown
function withdrawStake(uint256 agentId) external;                    // after WITHDRAW_DELAY
function slash(uint256 agentId, uint96 amount, bytes32 reason) external; // SLASHER_ROLE
function getAgent(uint256 agentId) external view returns (Agent memory);
function isHireable(uint256 agentId) external view returns (bool);
```

Design notes:

- **Field order is chosen for storage packing**, not readability. The ordering
  above uses 3 slots for the fixed fields; the obvious ordering
  (`owner, wallet, price, stake, …`) uses 4, because a 20-byte `address`
  cannot share the 12 bytes left over from the previous `address`.
- **Stake with a withdrawal delay** (`WITHDRAW_DELAY = 7 days`). Without a
  delay, an agent could take a large job and pull its bond in the same block.
- **`capabilitiesRoot` as a merkle root, not an array.** Capability lists are
  read constantly off-chain and written rarely; storing an unbounded array
  on-chain is pure cost. The full list lives in `metadataURI`; the root lets
  anyone prove a claimed capability was registered.
- `isHireable` = `active && stake >= MIN_STAKE && !slashedBelowFloor`.

### 2.2 `TaskEscrow`

The core contract. Holds funds, owns the state machine, is the only writer to
reputation.

```solidity
enum JobState { NONE, CREATED, ACCEPTED, SUBMITTED, DISPUTED, SETTLED, REFUNDED }

struct Job {
    // slot 0 — 8 + 8 + 16 = 32 bytes exactly
    uint64  clientAgentId;   // see the downcast note below
    uint64  workerAgentId;
    uint128 amount;          // gross, in payment-token base units
    // slot 1 — 16 + 8 + 8 = 32 bytes exactly
    uint128 fee;             // captured at creation; governance cannot alter an in-flight job
    uint64  acceptDeadline;
    uint64  workDeadline;
    // slot 2
    uint64  reviewDeadline;  // set when the result is submitted
    JobState state;
    // slots 3-4
    bytes32 specHash;        // keccak256 of the canonical job spec JSON
    bytes32 resultHash;      // keccak256 of the canonical result JSON
}
```

**Agent id width.** Every *external* signature takes `uint256 agentId`, matching
ERC-8004 exactly so nothing truncates at the boundary. Storage packs to
`uint64` via a **checked** downcast that reverts with
`AgentIdTooLarge(uint256)` rather than wrapping.

Probed on Monad mainnet 2026-09-22: the live Identity Registry issues
sequential ids (`ownerOf(1)`, `(2)`, `(3)`, `(100)` are all held), so `uint64`
covers ~1.8×10¹⁹ agents. But it is an upgradeable proxy and the standard
permits any `uint256`, so the guard is load-bearing, not decorative.

```solidity

event JobCreated(uint256 indexed jobId, uint256 indexed client, uint256 indexed worker,
                 uint128 amount, bytes32 specHash, uint64 acceptDeadline);
event JobAccepted(uint256 indexed jobId, uint64 workDeadline);
event ResultSubmitted(uint256 indexed jobId, bytes32 resultHash, string resultURI);
event JobSettled(uint256 indexed jobId, uint128 paid, uint128 fee);
event JobRefunded(uint256 indexed jobId, uint128 amount, bytes32 reason);
event JobDisputed(uint256 indexed jobId, bytes32 reasonHash);
event DisputeResolved(uint256 indexed jobId, bool forWorker);
event DirectPaid(uint256 indexed jobId, uint256 indexed client, uint256 indexed worker, uint128 amount);

// --- escrow path ---
function createJob(
    uint256 clientAgentId,
    uint256 workerAgentId,
    uint128 amount,
    bytes32 specHash,
    uint64  acceptWindow,
    uint64  workWindow
) external returns (uint256 jobId);

function acceptJob(uint256 jobId) external;                               // worker wallet
function submitResult(uint256 jobId, bytes32 resultHash, string calldata uri) external;
function approve(uint256 jobId) external;                                 // client wallet
function dispute(uint256 jobId, bytes32 reasonHash) external;             // client, in review window
function resolveDispute(uint256 jobId, bool forWorker) external;          // ARBITER_ROLE
function cancel(uint256 jobId) external;                                  // client, CREATED only

// --- permissionless liveness transitions ---
function expireUnaccepted(uint256 jobId) external;   // past acceptDeadline  → REFUNDED
function expireUndelivered(uint256 jobId) external;  // past workDeadline    → REFUNDED
function autoApprove(uint256 jobId) external;        // past reviewDeadline  → SETTLED

// --- fast path ---
function directPay(
    uint256 clientAgentId,
    uint256 workerAgentId,
    uint128 amount,
    bytes32 specHash
) external returns (uint256 jobId);   // reverts if amount > fastPathMax

function getJob(uint256 jobId) external view returns (Job memory);

/// @notice Sum of `amount` across all non-terminal jobs.
/// @dev Exists so invariant I1 is checkable on-chain in one call rather than
///      reconstructed by iterating jobs off-chain.
function lockedTotal() external view returns (uint256);
```

Two events deserve explanation:

```solidity
event JobSettled(uint256 indexed jobId, uint128 paid, uint128 fee, Outcome outcome);
event FeedbackFailed(uint256 indexed jobId, uint256 indexed agentId);
```

`FeedbackFailed` is the safety valve for the ERC-8004 dependency. The
Reputation Registry is an **upgradeable proxy owned by someone else** — if it
is upgraded, paused, or reverts for any reason, a `giveFeedback()` call inside
`_settle()` would revert the settlement and **trap the worker's money**.

So the call is wrapped in `try/catch`: on failure it emits `FeedbackFailed`
and settlement proceeds regardless. Reputation is best-effort; **payment is
not**. Missing feedback can be replayed later from the event log; a stuck
escrow cannot be undone.

**Caller authorisation.** Every function above is gated on the caller being the
relevant agent's registered wallet, resolved through the **ERC-8004 Identity
Registry** via `getAgentWallet(agentId)`:

| Function | Required `msg.sender` |
|---|---|
| `createJob`, `directPay`, `cancel`, `approve`, `dispute` | `registry.getAgent(clientAgentId).wallet` |
| `acceptJob`, `submitResult` | `registry.getAgent(workerAgentId).wallet` |
| `resolveDispute` | `ARBITER_ROLE` |
| `expireUnaccepted`, `expireUndelivered`, `autoApprove` | anyone (that is the point) |

Without this, anyone could create a job charged to another agent's wallet.

Invariants the contract must hold — these become Foundry invariant tests:

| # | Invariant |
|---|---|
| I1 | `token.balanceOf(escrow) >= Σ amount of jobs in {CREATED, ACCEPTED, SUBMITTED, DISPUTED}` |
| I2 | A job in a terminal state (`SETTLED`, `REFUNDED`) can never transition again |
| I3 | Every state change emits exactly one event |
| I4 | `paid + fee == amount` on every settlement; no dust is stranded |
| I5 | Every non-terminal job has a deadline strictly in the future *or* an enabled permissionless exit |
| I6 | `clientAgentId != workerAgentId` (no self-dealing to farm reputation) |
| I7 | `giveFeedback()` is called **only** from `_settle()`, after funds have moved — never on a path reachable without a completed payment |
| I8 | A reverting `giveFeedback()` can never revert a settlement (try/catch + `FeedbackFailed`). Payment must not depend on a third party's upgradeable contract |

Implementation requirements:

- `SafeERC20` for every transfer; assume a non-standard token.
- `nonReentrant` on every state-changing external function.
- **Checks-effects-interactions**: set `state` before transferring.
- `Pausable` — `whenNotPaused` on `createJob` and `directPay` only. Pausing
  must never trap funds already in escrow; settlement and refund stay open.
- Fee is read from storage at settlement but **captured into the job at
  creation**, so a governance fee change cannot alter an in-flight job.

### 2.3 `ReputationRegistry`

> **Fallback only.** ERC-8004's Reputation Registry is used instead — see
> [§2.0](#20-erc-8004-integration-the-live-path). The scoring formula below
> still applies; only its input source changes.
>
> **Where the score comes from.** Not from a live `getSummary()` call.
> That function loops `for j = 1..lastIndex` over every feedback entry per
> client, and because AGENTX is a *single* client address, an agent with 1,284
> settled jobs means a 1,284-iteration loop in one `eth_call` — it will hit RPC
> gas caps. The indexer therefore derives the score from `NewFeedback` events,
> which it already consumes. `getSummary()` is kept for spot-checks and
> reconciliation, where the loop is short.

```solidity
enum Outcome { SUCCESS, FAILED, DISPUTE_LOST }

struct Stats {
    // slot 0 — 8 + 8 + 16 = 32 bytes exactly
    uint64  completed;
    uint64  failed;
    uint128 volume;       // gross value settled, base units
    // slot 1 — 4 + 8 = 12 bytes
    uint32  disputed;
    uint64  lastActiveAt;
}

event ReputationRecorded(uint256 indexed agentId, Outcome outcome, uint128 amount);

function record(uint256 agentId, Outcome outcome, uint128 amount) external; // RECORDER_ROLE = TaskEscrow
function statsOf(uint256 agentId) external view returns (Stats memory);
function scoreOf(uint256 agentId) external view returns (uint16);           // 0..100
```

`scoreOf` implements the smoothed, volume-damped formula from
[02-flowcharts §6](02-flowcharts.md#6-reputation-update), in integer math:

```solidity
uint256 internal constant CONFIDENCE_FLOOR = 25;   // jobs needed for full confidence

function scoreOf(uint256 agentId) public view returns (uint16) {
    Stats memory s = _stats[agentId];
    uint256 n = uint256(s.completed) + uint256(s.failed);
    if (n == 0) return 50;                         // unproven, not "perfect"

    // Laplace-smoothed success rate, 0..100
    uint256 raw = (100 * (uint256(s.completed) + 1)) / (n + 2);

    // confidence 0..100, reaching full at CONFIDENCE_FLOOR settled jobs
    uint256 conf = n >= CONFIDENCE_FLOOR ? 100 : (n * 100) / CONFIDENCE_FLOOR;

    // pull toward 50 by (1 - confidence). Branch, do NOT compute
    // (raw - 50) unguarded: raw < 50 underflows and reverts in 0.8.x,
    // which would make scoreOf() revert for every below-average agent.
    if (raw >= 50) return uint16(50 + ((raw - 50) * conf) / 100);
    return uint16(50 - ((50 - raw) * conf) / 100);
}
```

Worked examples — these become the unit-test table:

| completed | failed | raw | conf | score | reading |
|---|---|---|---|---|---|
| 0 | 0 | — | — | **50** | unproven |
| 1 | 0 | 66 | 4 | **50** | one lucky job proves nothing |
| 25 | 0 | 96 | 100 | **96** | proven and clean |
| 1284 | 81 | 94 | 100 | **94** | the marketplace example |
| 0 | 5 | 14 | 20 | **43** | bad, but not yet conclusive |
| 0 | 50 | 1 | 100 | **1** | conclusively bad |

A fresh agent scores 50, not 0 and not 100 — it is unknown, not bad and not
proven. That single choice is what stops both the cold-start problem and the
one-lucky-job sybil.

### 2.4 `AgentAccount` and `AgentAccountFactory`

A minimal smart account per agent, holding its funds and enforcing its
spending policy on-chain.

```solidity
struct Policy {
    uint128 perTaskCap;
    uint128 dailyCap;
    uint64  dayStart;       // rolling window anchor
    uint128 spentToday;
    bool    allowlistOnly;  // if true, only allowlisted counterparties
}

event PolicySet(uint128 perTaskCap, uint128 dailyCap, bool allowlistOnly);
event SessionKeyGranted(address indexed key, uint64 expiry, uint128 budget);
event SessionKeyRevoked(address indexed key);
event Executed(address indexed target, uint256 value, bytes4 selector);

function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory);
function setPolicy(Policy calldata p) external;                          // owner only
function grantSessionKey(address key, uint64 expiry, uint128 budget) external;  // owner only
function revokeSessionKey(address key) external;                         // owner OR the key itself
function setAllowlist(address counterparty, bool allowed) external;
function sweep(address token, uint256 amount) external;                  // owner only
```

`execute` enforces, in order:

1. caller is the owner, or a session key that is unexpired and within budget
2. `target` is allowlisted (registry, escrow, payment token — nothing else)
3. the selector is in the permitted set (no arbitrary `approve` to anywhere)
4. decoded spend ≤ `perTaskCap`
5. `spentToday + spend ≤ dailyCap`, rolling the window if the day has turned

Every one of those checks exists because the signer service could be
compromised. The account is the last line: even with the key, an attacker
cannot exceed the daily cap or send funds to an address the owner never
allowlisted.

> ERC-4337 bundler support is explicitly **out of scope for the MVP**. The
> account is a plain smart contract called by an EOA session key. The interface
> is shaped so 4337 can be added later without changing the escrow.

### 2.5 Parameters

> **These values are not declared here.** They live in
> `config/params.<chainId>.json` and are read by the deploy script, the
> backend, and the UI — see [08 §3](08-configuration.md#3-protocol-parameters--configparamschainidjson).
> The table below is a **copy for reading**, regenerated from those files, and
> a CI test asserts it matches what is actually deployed.

| Parameter | Testnet (10143) | Mainnet (143) | Contract |
|---|---|---|---|
| `minStake` | 10 USDC | 100 USDC | StakeVault |
| `withdrawDelay` | 7 days | 14 days | StakeVault |
| `fastPathMax` | 0.03 USDC | 0.50 USDC | TaskEscrow |
| `fastPathMinScore` | 70 | 80 | TaskEscrow |
| `protocolFeeBps` | 100 (1%) | 100 (1%) | TaskEscrow |
| `acceptWindow` | 5 min | 15 min | caller-supplied, clamped |
| `workWindow` | 30 min | 60 min | caller-supplied, clamped |
| `reviewWindow` | 10 min | 60 min | TaskEscrow |
| `confidenceFloor` | 25 jobs | 50 jobs | off-chain (`@agentx/config`) |

Mainnet is more conservative in every row, and deliberately so: a ten-minute
review window is fine when a failed demo costs nothing and indefensible when
real funds auto-release against it.

Constructor args stay network-independent (`admin` only); parameters arrive
through a post-deploy `configure()`. That is what makes CREATE2 give identical
addresses on both networks — see [08 §4](08-configuration.md#deterministic-addresses-across-networks).

All are settable by `DEFAULT_ADMIN_ROLE` (a multisig in production, a single
key on testnet) and all emit events on change.

**Why testnet `fastPathMax` is 0.03 and not something rounder:** the demo
hires at 0.02 (direct) and 0.05 (escrow). The threshold has to sit between
them or `path: "auto"` sends both down the same route and the demo only ever
shows one of the two mechanisms. Mainnet uses 0.50, which is the value a real
deployment wants. Say this out loud in the submission rather than letting a
judge notice the testnet threshold looks arbitrary.

---

## 3. Wallet architecture

### 3.1 The three-key model

```
   OWNER KEY  (human, hardware wallet / RainbowKit)
        │  registers the agent, sets policy, can sweep funds, can revoke
        ▼
   AGENT ACCOUNT  (smart contract, holds USDC + MON)
        ▲
        │  calls execute() within policy
   SESSION KEY  (hot, in KMS, rotated every 24h, budget-capped)
        ▲
        │  signs
   SIGNER SERVICE
```

The human never approves individual payments — that is the entire point — but
retains the two powers that matter: **revoke** and **sweep**. Autonomy with a
kill switch.

### 3.2 Signer service

One process. One job. Refuses everything else.

```
POST /sign  { agentId, target, value, data, idempotencyKey }
   ├─ authenticate caller (mTLS or signed service token)
   ├─ load policy snapshot for agentId
   ├─ off-chain pre-check: same 5 rules the contract enforces
   ├─ check idempotencyKey in Redis      → replay returns the original tx hash
   ├─ check MON balance >= GAS_FLOOR     → else top up from funder, or 503
   ├─ KMS sign with agent session key
   ├─ broadcast, record (agentId, nonce, txHash) in Postgres
   └─ return { txHash, nonce }
```

- **Nonce management** is centralised here with a per-agent Postgres advisory
  lock. Two concurrent hires for the same agent cannot produce the same nonce.
- **Idempotency** is mandatory: agents retry, and a retried hire must not
  create a second job. The key is `hash(agentId, specHash, workerAgentId)`.
- **Gas top-ups** are pull-based from a funder wallet with its own daily cap.
- The service **pre-checks the same rules the contract enforces**. Duplication
  is intentional: the off-chain check gives a useful error, the on-chain check
  gives the guarantee.

### 3.3 Key handling

| Environment | Owner key | Session key |
|---|---|---|
| local dev | anvil account 0 | encrypted keystore file, gitignored |
| testnet demo | RainbowKit browser wallet | AWS KMS, 24h rotation |
| production | hardware wallet / Safe multisig | AWS KMS, per-agent, 24h rotation |

Rules, no exceptions: no private key in `.env` beyond local dev, no key in
logs, no key in a Postgres column, `.env.example` ships empty. Key rotation is
a `grantSessionKey` + `revokeSessionKey` pair — no funds move, no downtime.

---

## 4. Database schema

PostgreSQL 16. The chain is the source of truth for money; this is a
queryable projection plus the off-chain payloads.

> **Multi-chain.** Every chain-derived table carries `chain_id`, and every
> uniqueness constraint is scoped to it. Agent `#42` on testnet and agent `#42`
> on mainnet are different agents with separate reputations. See
> [08 §8](08-configuration.md#8-multi-chain-data-model) for the reasoning.

```sql
-- ─────────────── identity ───────────────
CREATE TABLE agents (
  id                BIGSERIAL PRIMARY KEY,
  chain_id          BIGINT NOT NULL,                -- 10143 testnet, 143 mainnet
  chain_agent_id    NUMERIC(78,0),                  -- NULL until indexed
  owner_address     TEXT NOT NULL,
  wallet_address    TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  endpoint_url      TEXT,                           -- webhook, NULL = polling
  price_per_task    NUMERIC(38,0) NOT NULL,         -- base units
  stake             NUMERIC(38,0) NOT NULL DEFAULT 0,
  metadata_uri      TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_non_negative CHECK (price_per_task >= 0)
);

-- uniqueness is ALWAYS per-chain, never global
CREATE UNIQUE INDEX agents_chain_agent_uk ON agents (chain_id, chain_agent_id);
CREATE UNIQUE INDEX agents_chain_wallet_uk ON agents (chain_id, wallet_address);

CREATE TABLE agent_capabilities (
  agent_id   BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability TEXT   NOT NULL,                       -- 'market-research'
  PRIMARY KEY (agent_id, capability)
);
CREATE INDEX ON agent_capabilities (capability);

-- discovery is always scoped to one chain
CREATE INDEX agents_discovery_idx ON agents (chain_id, active, price_per_task)
  WHERE active;

-- ─────────────── reputation (projection) ───────────────
CREATE TABLE agent_stats (
  agent_id       BIGINT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  completed      BIGINT NOT NULL DEFAULT 0,
  failed         BIGINT NOT NULL DEFAULT 0,
  disputed       BIGINT NOT NULL DEFAULT 0,
  volume         NUMERIC(38,0) NOT NULL DEFAULT 0,
  score          SMALLINT NOT NULL DEFAULT 50,      -- mirrors scoreOf()
  last_active_at TIMESTAMPTZ
);

-- ─────────────── jobs ───────────────
CREATE TYPE job_state AS ENUM
  ('created','accepted','submitted','disputed','settled','refunded');
CREATE TYPE job_path AS ENUM ('escrow','direct');

CREATE TABLE jobs (
  id                BIGSERIAL PRIMARY KEY,
  chain_id          BIGINT NOT NULL,
  chain_job_id      NUMERIC(78,0),
  client_agent_id   BIGINT NOT NULL REFERENCES agents(id),
  worker_agent_id   BIGINT NOT NULL REFERENCES agents(id),
  path              job_path NOT NULL,
  state             job_state NOT NULL DEFAULT 'created',
  amount            NUMERIC(38,0) NOT NULL,
  fee               NUMERIC(38,0),
  spec              JSONB NOT NULL,                 -- the canonical job spec
  spec_hash         TEXT NOT NULL,
  result            JSONB,
  result_hash       TEXT,
  result_uri        TEXT,
  accept_deadline   TIMESTAMPTZ,
  work_deadline     TIMESTAMPTZ,
  review_deadline   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at        TIMESTAMPTZ,
  trace_id          TEXT,                           -- links to the agent trace
  CONSTRAINT no_self_dealing CHECK (client_agent_id <> worker_agent_id),
  CONSTRAINT amount_positive CHECK (amount > 0)
);
CREATE UNIQUE INDEX jobs_chain_job_uk ON jobs (chain_id, chain_job_id);
CREATE INDEX ON jobs (chain_id, worker_agent_id, state);
CREATE INDEX ON jobs (chain_id, client_agent_id, created_at DESC);
CREATE INDEX ON jobs (chain_id, state) WHERE state IN ('created','accepted','submitted');

-- a job may never span two chains. Enforced with a composite FK so the
-- database, not the application, is what guarantees it.
ALTER TABLE agents ADD CONSTRAINT agents_id_chain_uk UNIQUE (id, chain_id);
ALTER TABLE jobs
  ADD CONSTRAINT jobs_client_same_chain
      FOREIGN KEY (client_agent_id, chain_id) REFERENCES agents (id, chain_id),
  ADD CONSTRAINT jobs_worker_same_chain
      FOREIGN KEY (worker_agent_id, chain_id) REFERENCES agents (id, chain_id);

-- append-only audit log; never updated, never deleted
CREATE TABLE job_events (
  id          BIGSERIAL PRIMARY KEY,
  chain_id    BIGINT NOT NULL,
  job_id      BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                        -- 'created','accepted',…
  payload     JSONB NOT NULL DEFAULT '{}',
  tx_hash     TEXT,
  block_number BIGINT,
  log_index   INT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index)             -- idempotent indexing
);
CREATE INDEX ON job_events (job_id, id);

-- ─────────────── money ───────────────
CREATE TABLE payments (
  id            BIGSERIAL PRIMARY KEY,
  chain_id      BIGINT NOT NULL,
  job_id        BIGINT REFERENCES jobs(id),
  from_agent_id BIGINT REFERENCES agents(id),
  to_agent_id   BIGINT REFERENCES agents(id),
  amount        NUMERIC(38,0) NOT NULL,
  fee           NUMERIC(38,0) NOT NULL DEFAULT 0,
  tx_hash       TEXT NOT NULL,
  block_number  BIGINT NOT NULL,
  confirmed_at  TIMESTAMPTZ,
  UNIQUE (chain_id, tx_hash, job_id)
);

CREATE TABLE spend_policies (
  agent_id      BIGINT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  per_task_cap  NUMERIC(38,0) NOT NULL,
  daily_cap     NUMERIC(38,0) NOT NULL,
  spent_today   NUMERIC(38,0) NOT NULL DEFAULT 0,
  day_start     TIMESTAMPTZ NOT NULL DEFAULT date_trunc('day', now()),
  allowlist_only BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE signer_txs (
  id              BIGSERIAL PRIMARY KEY,
  agent_id        BIGINT NOT NULL REFERENCES agents(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  nonce           BIGINT NOT NULL,
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|mined|failed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, nonce)
);

-- ─────────────── disputes & auth ───────────────
CREATE TABLE disputes (
  job_id       BIGINT PRIMARY KEY REFERENCES jobs(id),
  raised_by    BIGINT NOT NULL REFERENCES agents(id),
  reason       TEXT NOT NULL,
  reason_hash  TEXT NOT NULL,
  resolved_for TEXT,                                -- 'worker' | 'client'
  resolved_at  TIMESTAMPTZ
);

CREATE TABLE api_keys (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,                 -- argon2id, never the key
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

-- ─────────────── indexer bookkeeping ───────────────
CREATE TABLE indexer_cursor (
  chain_id      BIGINT NOT NULL,
  contract      TEXT NOT NULL,
  last_block    BIGINT NOT NULL,
  last_block_hash TEXT NOT NULL,                    -- reorg detection
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract)                  -- one cursor per chain
);
```

Schema notes worth defending in a review:

- **`NUMERIC(38,0)`, never float, never `bigint`, for token amounts.** Money is
  integer base units end to end. A rounding error in a demo is a lost job; in
  production it is a lost audit.
- **`job_events` is append-only with `UNIQUE (chain_id, tx_hash, log_index)`.**
  That one constraint makes the indexer safely re-runnable: replaying a block
  range is a no-op rather than a duplication.
- **`no_self_dealing` is a database CHECK as well as a contract require.** The
  reputation system is only as good as its weakest writer.
- **Every uniqueness constraint is scoped by `chain_id`.** A global unique on
  `chain_agent_id` would make the second network fail to index at agent #1.
  The composite foreign keys go further and make a cross-chain job
  *structurally* impossible rather than merely checked.
- `spent_today` here is a cache for fast rejection; `AgentAccount.spentToday`
  is the authority.

---

## 5. API specification

`https://api.agentx.dev/v1`. JSON in, JSON out. Auth is a bearer API key
scoped to one agent (`Authorization: Bearer ax_live_…`).

All amounts are **strings of base units** (`"20000"` = 0.02 USDC at 6dp).
Never floats, never numbers that could exceed 2^53.

**Network selection.** One deployment serves every chain in
`ENABLED_CHAIN_IDS`. Every request may carry `?chainId=`; when omitted it
resolves to `DEFAULT_CHAIN_ID` (10143). **Every response echoes `chainId` and
`network`** so a client never has to infer which chain a result came from:

```json
{ "chainId": 10143, "network": "Monad Testnet", "…": "…" }
```

An API key is bound to an agent, and an agent belongs to exactly one chain, so
a key used against the wrong `chainId` gets `CHAIN_MISMATCH` (409) rather than
silently operating on the wrong network.

### 5.1 Agents

```http
POST /v1/agents
{
  "name": "ResearchBot",
  "description": "On-chain market research and liquidity analysis",
  "capabilities": ["market-research", "data-analysis"],
  "pricePerTask": "20000",
  "endpointUrl": "https://researchbot.example/agentx",
  "stake": "10000000"
}
→ 201 { "agentId": 42, "walletAddress": "0x…", "txHash": "0x…", "status": "pending" }
```

```http
GET /v1/agents?capability=market-research&maxPrice=50000&minScore=80&limit=10
    &rank=quality            # quality | cheapest | fastest | balanced (default)
→ 200 {
  "agents": [{
    "agentId": 42, "name": "ResearchBot",
    "capabilities": ["market-research","data-analysis"],
    "pricePerTask": "20000",
    "score": 94, "completed": 1284, "failed": 81,
    "successRate": 0.941, "avgCompletionSeconds": 8.2,
    "walletAddress": "0x…", "active": true
  }],
  "nextCursor": null
}
```

```http
GET   /v1/agents/{agentId}
PATCH /v1/agents/{agentId}          { "pricePerTask": "25000", "active": true }
GET   /v1/rank-modes                the four ranking modes discovery accepts
```

### 5.2 Jobs

```http
POST /v1/jobs
Idempotency-Key: 9f2c…                       # required
{
  "workerAgentId": 42,
  "spec": {
    "capability": "market-research",
    "input": { "question": "ETH/USDC liquidity depth on Monad DEXes" },
    "outputSchema": { "type": "object", "required": ["summary","sources"] },
    "deadlineSeconds": 120
  },
  "maxPrice": "25000",
  "path": "auto"                              # auto | escrow | direct
}
→ 201 {
  "jobId": "1187", "chainJobId": "1187",
  "state": "created", "path": "direct",
  "amount": "20000", "fee": "200",
  "txHash": "0xab…",
  "explorerUrl": "https://…/tx/0xab…",
  "specHash": "0x7d…"
}
```

`path: "auto"` applies the rule from
[02-flowcharts §4](02-flowcharts.md#4-fast-path-vs-escrow-path). The response
always states which path was taken, so the caller is never surprised about
whether its money is protected.

```http
GET  /v1/jobs/{jobId}
→ 200 { jobId, state, path, amount, fee, spec, result, resultHash,
        worker: {...}, client: {...}, events: [...], txHashes: {...} }

GET  /v1/jobs?role=worker&state=created&limit=25
                                  # how a worker learns it was hired
POST /v1/jobs/{jobId}/accept      # worker scope
POST /v1/jobs/{jobId}/result      { "output": {...}, "producedAt": "<iso8601>" }
                                  # worker scope; `output` is validated
                                  # against the job's own outputSchema
POST /v1/jobs/{jobId}/approve     # client scope
POST /v1/jobs/{jobId}/dispute     { "reason": "schema mismatch" }
POST /v1/jobs/{jobId}/cancel      # client scope, CREATED only

GET  /v1/jobs/{jobId}/events      # text/event-stream
```

SSE frames:

```
event: job.created     data: {"jobId":"1187","txHash":"0xab…"}
event: job.confirmed   data: {"jobId":"1187","blockNumber":48213}
event: job.accepted    data: {"jobId":"1187","workerAgentId":42}
event: job.result      data: {"jobId":"1187","resultHash":"0x9c…"}
event: job.settled     data: {"jobId":"1187","paid":"19800","fee":"200"}
```

### 5.2b Network, budget and runs

```
GET  /v1/network                  chain, testnet flag, payment token, windows,
                                  the ERC-8004 registry ABI variant, public RPCs
GET  /v1/budget                   per-task cap, daily remaining, maxSingleSpend,
                                  and whether the numbers came from the chain
                                  or from our cache

POST /v1/runs                     { "goal": "..." } -> 202 { runId, eventsUrl }
GET  /v1/runs?limit=20            the caller's runs, newest first
GET  /v1/runs/{runId}             goal, state, answer, per-step outcomes, trace
GET  /v1/runs/{runId}/events      # text/event-stream, replayed from the start

GET  /health                      chains, default chain, whether an
                                  orchestrator is configured
```

Reading a run needs no credentials — the trace is the thing being
demonstrated. Starting one does, because it spends, and it runs under the
calling agent's own on-chain caps.

**Staking is not an API endpoint.** An owner bonds an agent by calling
`StakeVault.deposit` directly; putting it behind the API would mean the API
moving an owner's funds, which is exactly the custody it does not have.

### 5.3 Errors

RFC 7807 problem details, with machine-readable codes agents can branch on:

```json
{ "type": "https://agentx.dev/errors/budget-exceeded",
  "title": "Daily spending cap reached",
  "status": 402,
  "code": "BUDGET_EXCEEDED",
  "detail": "agent 7 has spent 1.00 of 1.00 USDC today",
  "retryAfter": 41230 }
```

| Code | Status | Meaning |
|---|---|---|
| `AGENT_NOT_HIREABLE` | 409 | inactive, or stake below minimum |
| `PRICE_ABOVE_MAX` | 409 | worker price exceeds caller's `maxPrice` |
| `BUDGET_EXCEEDED` | 402 | per-task or daily cap hit |
| `INSUFFICIENT_FUNDS` | 402 | agent wallet cannot cover amount + gas |
| `INVALID_STATE` | 409 | transition not legal from current state |
| `DEADLINE_PASSED` | 410 | window closed; job is refundable |
| `SCHEMA_MISMATCH` | 422 | result failed `outputSchema` validation |
| `IDEMPOTENCY_CONFLICT` | 409 | same key, different body |
| `CHAIN_MISMATCH` | 409 | key's agent is on a different chain than `?chainId=` |
| `CHAIN_NOT_ENABLED` | 400 | `chainId` is not in `ENABLED_CHAIN_IDS` |

### 5.4 Cross-cutting rules

- **Idempotency-Key required on every POST that spends money.** Stored 24h,
  replay returns the original response verbatim.
- Rate limits per API key: 60 writes/min, 600 reads/min.
- Every response carries `x-trace-id`, matching the agent's OTel trace.
- Pagination is cursor-based. No offsets.

---

## 6. The MCP agent interface

The same capabilities, exposed as MCP tools so any MCP-capable agent — ours,
or a judge's — can transact without writing an HTTP client.

| Tool | Input | Output |
|---|---|---|
| `discover_agents` | `capability`, `maxPrice?`, `minScore?`, `rank?` | ranked candidates with price and score |
| `hire_agent` | `agentId`, `spec`, `maxPrice`, `path?` | `jobId`, path taken, txHash, explorer URL |
| `get_job` | `jobId` | state, result (if any), receipts |
| `await_result` | `jobId`, `timeoutSeconds` | blocks until settled/failed, returns result |
| `approve_job` | `jobId` | settlement receipt |
| `dispute_job` | `jobId`, `reason` | dispute receipt |
| `my_budget` | — | remaining per-task and daily budget |
| `get_network` | — | chain ID, name, whether it is a testnet, payment token symbol |

Two design rules:

1. **Tool descriptions state the cost.** `hire_agent` says plainly that it
   spends real funds up to `maxPrice`. An agent should never spend money
   without the tool having told it so.
2. **`my_budget` exists so an agent can plan.** Without it, the agent
   discovers its limits only by hitting 402s, which is how you get retry storms.
3. **`get_network` reports `testnet: true/false`.** An autonomous agent
   should be able to know whether the money it is about to spend is real. Every
   tool that spends includes the network in its result for the same reason.

---

## 7. Agent workflow

### 7.1 Orchestrator (the "main agent")

```
receive user goal
   │
   ▼
plan: decompose into subtasks, each with a capability tag
   │
   ▼
for each subtask:
   │   my_budget()  ─── insufficient ──▶ degrade: fewer subtasks, or ask user
   │
   ├─ discover_agents(capability, maxPrice = remaining/steps, minScore = 70)
   │      │
   │      └─ none found ──▶ widen capability, raise maxPrice within budget,
   │                        or do it in-house and say so
   ├─ pick candidate by rank
   ├─ hire_agent(...)                      ── budget/funds error ──▶ next candidate
   ├─ await_result(jobId, timeout)
   │      ├─ timeout   ──▶ expire → refund → try next candidate
   │      └─ result
   ├─ validate against spec.outputSchema
   │      ├─ valid    ──▶ approve_job
   │      └─ invalid  ──▶ dispute_job, try next candidate
   └─ feed result into the next subtask's input
   │
   ▼
synthesise final answer + receipts (jobIds, amounts, explorer links)
```

The failure branches are not decoration. An orchestrator that only handles
the happy path will stall live in front of judges the first time a worker is
slow.

### 7.2 Worker agent loop

```
authenticate  →  subscribe to offers (SSE) or poll GET /v1/jobs?state=created&worker=me
   │
   ▼
offer received
   ├─ can I do this? (capability match, input parses, schema satisfiable)
   ├─ is the price worth it? (amount >= my floor)
   ├─ can I finish before workDeadline?
   │      any "no" ──▶ decline (do not accept and then fail; that costs reputation)
   │
   ├─ accept  →  POST /v1/jobs/{id}/accept
   ├─ do the work (LLM call, API call, computation)
   ├─ validate own output against spec.outputSchema
   └─ POST /v1/jobs/{id}/result
   │
   ▼
settled → payment lands in the agent's wallet, reputation increments
```

**The decline path is the reputation strategy.** A worker that accepts
everything and fails 20% of the time ranks below one that accepts selectively
and completes 99%. The economics reward honesty about capability, which is
exactly the incentive the system is supposed to create.

### 7.3 Prompt-injection containment

A result from another agent is **untrusted input**, not instructions. Every
agent applies the same three rules:

1. Results are injected into the prompt inside a delimited, clearly-labelled
   data block, never concatenated into the instruction section.
2. The orchestrator's spending tools are gated by `my_budget` caps that a
   result cannot alter. The worst a malicious result can do is waste one
   subtask's budget, not drain the wallet.
3. Results are schema-validated **before** they reach the model. A result that
   does not match `outputSchema` is disputed, not read.

---

## 8. Money: fees, decimals, accounting

- Payment token has **6 decimals**; all amounts are integer base units.
  `0.02 USDC == 20000`.
- Protocol fee `100 bps`, taken at settlement, captured at job creation.
  `fee = (amount * feeBps) / 10_000` (integer division, rounds **down**), and
  `paid = amount - fee`. So `paid + fee == amount` exactly — invariant I4 — and
  the rounding remainder goes to the **worker**, never to the protocol and
  never into thin air. Rounding in the protocol's own favour is the version of
  this that gets flagged in review.
- Gas is paid in MON by the acting agent, and is deliberately *not* netted out
  of the job amount — that would make prices unquotable.
- The escrow contract holds only job funds. Fees accrue to a separate
  `feeRecipient` and are swept by admin. This keeps invariant I1 clean.
- Every payment in Postgres carries its `tx_hash` and `block_number`. Any
  balance shown in the UI must be reconstructible from `payments` alone.

---

## 9. Security model and threats

### 9.1 Trust assumptions

| Party | Trusted for |
|---|---|
| Contracts | everything about custody and outcome |
| Indexer | liveness only — it can be slow, it cannot lie (events are signed by the chain) |
| API / signer | availability and good errors — **not** custody; policy is enforced on-chain |
| Agents | nothing |
| Arbiter (MVP) | dispute outcomes only, and only for disputed jobs |

The arbiter is the honest weak point of the MVP and the submission should say
so plainly. It is a multisig, it can only act on `DISPUTED` jobs, and it cannot
touch funds outside a dispute. The path beyond it is an optimistic
challenge window with staked challengers — designed for, not built in three weeks.

### 9.2 Threat table

| # | Threat | Mitigation |
|---|---|---|
| T1 | **Sybil agents** farming reputation | `MIN_STAKE` + withdrawal delay; new agents score 50 with volume damping so a fresh identity cannot outrank a proven one |
| T2 | **Self-dealing** — one owner hiring their own agent to farm score | `clientAgentId != workerAgentId` on-chain; off-chain clustering by owner address and funding source flags rings for review |
| T3 | **Worker takes payment, delivers nothing** | escrow above `fastPathMax`; `workDeadline` + permissionless `expireUndelivered` returns funds |
| T4 | **Client receives result, refuses to pay** | the hash of the delivered **output** is committed on-chain by `submitResult` before release; `reviewDeadline` + permissionless `autoApprove` settles without the client. Verified 2026-09-24 — until then the encoder fell back to the *spec* hash, committing to what was asked for rather than to what was delivered |
| T5 | **Both go offline mid-job, funds stuck** | every non-terminal state has a deadline and a permissionless exit (invariant I5) |
| T6 | **Reentrancy on settlement** | `nonReentrant`, checks-effects-interactions, `SafeERC20` |
| T7 | **Signer key compromise** | on-chain `AgentAccount` caps and allowlists bound the loss; owner can revoke and sweep. ⚠️ **Session key lifetime is NOT bounded on-chain** — `grantSessionKey(key, expiry, budget)` accepts any expiry the owner passes, so "expires in 24h" is operational policy, not a control. Nothing in AGENTX grants a session key today; the signer uses an EOA. See the open decision in `PROGRESS.md`. Corrected 2026-09-23 |
| T8 | **Replayed hire drains budget** | mandatory `Idempotency-Key`. The signer dedupes on **the key it is given**, stored `UNIQUE` in `signer_txs`; a replay returns the original `txHash` instead of signing again. `@agentx/sdk` derives that key from `keccak256(workerAgentId:canonicalJson(spec))` when the caller omits one, so an in-process retry is safe by default — but a caller supplying its own key controls dedupe, and two different keys for the same hire are two payments. Verified 2026-09-23 |
| T9 | **Prompt injection via a result** | results are delimited untrusted data, schema-validated pre-model, and cannot alter spending caps (§7.3) |
| T10 | **Runaway agent loop burning funds** | per-task + daily caps enforced in the contract, not only the app; `my_budget` lets the agent see the wall before hitting it |
| T11 | **Front-running `acceptJob`** to snipe good jobs | jobs are addressed to a named `workerAgentId`; there is no open mempool auction to snipe |
| T12 | **Fee-on-transfer / rebasing token** breaking accounting | balance delta measured on every transfer-in, reverting with `TokenDeliveredLess` on mismatch — in `TaskEscrow.createJob`, `directPay` and `StakeVault.deposit`. There is no allowlist: there is exactly **one** payment token, set once as a governance parameter, which is the stronger property. Verified 2026-09-23 |
| T13 | **Indexer reorg** writing a phantom payment | store `last_block_hash`; on mismatch, roll back N blocks and replay; `UNIQUE (tx_hash, log_index)` makes replay idempotent |
| T14 | **Griefing by mass job creation** | creating a job locks the client's own funds — spam is self-taxing; plus API rate limits |
| T15 | **Metadata URI pointing at malicious content** | **Not applicable as built: nothing fetches these URLs.** `metadata_uri` and `endpoint_url` are stored and returned verbatim, never dereferenced server-side, so there is no SSRF surface to guard. This was previously written as though the guard existed — it never did. If anything ever fetches them, the guard (size cap, timeout, content-type allowlist, no redirects to private ranges, no credentials) must be built **first**. Corrected 2026-09-23 |
| T17 | **Operator-approval griefing** — an agent owner calls `setApprovalForAll(taskEscrow, true)` on the Identity Registry, making `isAuthorizedOrOwner(taskEscrow, agentId)` true, so **every** `giveFeedback` for that agent reverts | Self-harm rather than an attack on others: it destroys only their own reputation writes. Invariant I8's try/catch keeps settlement working; each occurrence emits `FeedbackFailed`, which is alerted on and replayable from the event log |
| T16 | **Admin key compromise** | admin is a multisig; `pause` cannot trap escrowed funds; parameter changes are event-logged and cannot alter in-flight jobs |

### 9.3 What is explicitly not solved

State these in the submission rather than letting a judge find them:

- **Result quality is not cryptographically verified.** The MVP verifies
  *schema conformance and hash integrity*, not truth. Semantic verification
  (attestation, redundant execution, staked challenges) is future work.
- **Disputes are centralised** to a multisig arbiter.
- **No slashing game.** `slash()` exists and is role-gated but the MVP never
  calls it automatically.
- **No cross-chain settlement.**

---

## 10. Testing strategy

| Layer | Tool | Must cover |
|---|---|---|
| Contract unit | `forge test` | every state transition, including illegal ones reverting |
| Contract fuzz | `forge test --fuzz-runs 10000` | amounts, deadlines, fee rounding at boundaries |
| Contract invariant | `forge test --mt invariant_` | I1–I8 from §2.2 under randomised call sequences |
| Gas | `forge snapshot` | cost per hire committed to the repo; regressions fail CI |
| Backend | `vitest` + testcontainers | state machine, idempotency, SSE ordering |
| Indexer | replay fixtures | reorg rollback, duplicate log handling |
| E2E | scripted demo run against testnet | the full [§7 trace](#7-agent-workflow), asserted on explorer receipts |
| Chaos | manual, pre-demo | kill the worker mid-job; kill the indexer; hit the daily cap; submit a malformed result |

Coverage target: **100% of branches in `TaskEscrow`**, no exceptions. It is
the contract that holds the money.

The chaos row is the one teams skip and the one that decides the demo. Run it
the day before, not the hour before.

---

## 11. Open questions

Carry these as explicit unknowns rather than pretending they are settled:

1. **Is a canonical USDC available on the target Monad network?** If not,
   the demo uses `MockUSDC` and the submission says so in one honest line.
2. **Should `fastPathMax` be per-agent rather than global?** A high-reputation
   agent arguably deserves a larger trust-free ceiling.
3. **Does reputation need decay?** An agent with 1,284 completions from a year
   ago is not the same as one from last week. Time decay is easy to add and
   easy to get wrong.
4. **Batching.** Ten subtasks currently mean ten settlements. A per-epoch
   netting contract would cut that materially — the right v2 answer, and worth
   naming in the submission as the scaling path.
5. **Who pays the protocol fee** — worker (current design) or client? It
   changes how agents quote prices.
