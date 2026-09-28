# AGENTX — Progress

> **START HERE every session.** This file is the memory that survives a closed
> terminal. Read it top to bottom before doing anything else.

- Last updated: **2026-09-28** (Session 20 — docs audit, a real race, CI, interface tests)
- Days to deadline: **15** — verified: **2026-10-13, 11:59 PM ET**
- Target track: **4 — Trust, Identity & AI Infrastructure** ($30,000)
- Current state: **live on Monad testnet**; every layer built, none of it yet
  run end to end with a real model
- Overall: `█████████████████░░░` 84% — **97 / 115 tasks**, **306 tests green**
  (120 contracts · 179 backend · 7 interface)

---

## ⏭ Next actions

### 👤 You — 4 items, one of them blocking

1. **🔴 BLOCKING — a model API key** in `agentx-backend/.env`. That file does
   not exist yet. Free options, no card:
   `GEMINI_API_KEY=` (aistudio.google.com/apikey) or `GROQ_API_KEY=`.
   Do not paste it in chat.
   *Unblocks:* `pnpm demo`, M3's done-condition, 3 chaos items, the backup
   video — and the first end-to-end proof that the agent loop works at all.
2. **Railway** account + project (M2-22). Deferred to M5 by your earlier call.
3. **Vercel** account for `agentx-interface`.
4. **Arbiter and fee-recipient addresses** — both currently default to
   `DEPLOYER`. Fine for the demo; say if you want them separate.
5. **An explorer API key** (`EXPLORER_API_KEY` in `agentx-contracts/.env`) if
   you want verified source on the explorer. Contracts are deployed but **not
   verified**, so a judge following a link sees bytecode. The config that
   blocked verification is fixed; only the key is missing.

### 🤖 Claude — next, none of it blocked

1. Finish the docs drift audit: `05`, `06`, `08` still unaudited. This has the
   highest hit rate of anything right now — auditing `04 §5` yesterday found a
   defect that would have made the demo refuse to pay for every job.
2. Submission deck outline + the honest-limitations section.
3. The moment a key lands: `AGENT_MODE=record pnpm demo`, then the three
   remaining chaos items.

## 🚧 Blockers

| # | Blocked | Blocked by | Since | Owner |
|---|---|---|---|---|
| **B6** | `pnpm demo`, M3 done-condition, 3 chaos items, backup video | no model key in `agentx-backend/.env` | Sep 23 | 👤 |
| B7 | Interface visual verification | Chrome extension not connected in this session | Sep 23 | 👤 |
| B8 | Deploy + e2e against real hosting (M2-22/23, M5) | Railway + Vercel accounts | Sep 22 | 👤 |


Cleared: ~~B1 scaffolding~~ · ~~B2 funded wallets~~ · ~~B3 schedule~~ ·
~~B4 deploy target~~ · ~~B5 git push~~ · ~~B9 docs and plan unbacked~~
(moved into `agentx-backend` on Sep 25, which also fixed a README link that
was broken on GitHub).

> **B6 is the one that matters.** Every layer is built and tested in
> isolation, but the orchestrator → worker → judge → settle path has never
> executed against a real model. The last four defects all lived on exactly
> that path and all passed their unit tests first.

## 🔌 Cold start — resuming after the terminal closed

Everything a fresh session needs, assuming it knows nothing. Verified
2026-09-25.

### ✅ Everything is backed up (resolved 2026-09-25)

| Path | In git? |
|---|---|
| `agentx-contracts/` | ✅ pushed |
| `agentx-backend/` — including `docs/`, `PLAN.md`, `PROGRESS.md` | ✅ pushed |
| `agentx-interface/` | ✅ pushed |

Until 2026-09-25 the specification, the plan and this file lived in **no
repository** — ten documents in one folder, on one machine, named `temp`. The
code was safe on GitHub; the thinking behind it was one `rm` away. They now
live in `agentx-backend`, which also fixed a README link that was broken on
GitHub because it pointed at a `docs/` the repo did not contain.

No fourth repository was created — see the standing rules below.

### Where things are

```
<home>\code\temp\agentx\
├── agentx-contracts\   Foundry
├── agentx-interface\   Next.js
└── agentx-backend\     pnpm workspace — and the project's memory
    ├── PROGRESS.md     <- this file. Start here.
    ├── PLAN.md         <- ~115 tasks, owners, dependencies
    └── docs\           <- 00..10, the specification
```

`docs/07-what-i-need-from-you.md` is the checklist of things only you can
supply. Scratch files belong in the session scratchpad, never in the project.

### Bring everything up from cold

```bash
# 1. Infrastructure (from agentx-backend/)
docker compose up -d                       # Postgres :5442, Redis :6381
pnpm install
pnpm --filter @agentx/db migrate
pnpm -r build

# 2. Contracts
cd ../agentx-contracts && forge build

# 3. Prove it is all still green
FOUNDRY_PROFILE=ci forge test              # expect 120 passed
cd ../agentx-backend && npx tsc -b && npx vitest run   # expect 179 passed
cd ../agentx-interface && npx tsc --noEmit && npx next build
```

Expected totals as of 2026-09-25: **120 contracts + 179 backend = 299**.
If a number is lower, something regressed — find out what before building on
it.

### Running the stack locally

```bash
# API (needs no key; serves the marketplace with orchestrator: false)
cd agentx-backend
DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx \
ENABLED_CHAIN_IDS=10143 DEFAULT_CHAIN_ID=10143 \
AGENTX_CONTRACTS_ROOT=../agentx-contracts \
PORT=8080 node apps/api/dist/main.js

# Interface against it
cd agentx-interface
NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 pnpm dev

# Contract check (needs the API running)
NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 pnpm check:contract
```

Secrets for deploying live in `agentx-contracts/.env` (exists).
`agentx-backend/.env` **does not exist yet** and is what blocks `pnpm demo`.

### Live-chain checks need the deployer key

```bash
cd agentx-backend
set -a; . ../agentx-contracts/.env; set +a      # <- without this it silently
DATABASE_URL=postgres://agentx:agentx@127.0.0.1:5442/agentx VERIFY_CHAIN_ID=10143 AGENTX_CONTRACTS_ROOT=../agentx-contracts node scripts/verify-indexer.mjs                  #    uses the Anvil account
```

Without the env loaded the script falls back to the well-known Anvil key
`0xf39F…2266`, which has no funds on Monad, and fails on the first write with
a confusing revert.

### Environment gotchas — each of these cost real time

| Trap | What to do |
|---|---|
| Bash heredocs break on backticks and quotes | Use the Write tool for any file with them. This has bitten repeatedly. |
| `localhost` resolves to `::1` on Node 24 while Docker binds IPv4 | Always `127.0.0.1` in connection strings. |
| Ports 5432 / 6379 are taken by other projects on this machine | We use **5442** and **6381**. A native Postgres on 5432 silently shadowed the container once. |
| Node's `fetch` aborts the process at exit on Windows (0xC0000409) | Scripts whose exit code matters use `node:http`. |
| Python printing unicode to this shell throws `cp1252` errors | Write files with `encoding="utf-8"`; do not `print()` the content. |
| SSH picks the wrong key from the global config | Each repo pins `core.sshCommand` to `~/.ssh/id_github`. |
| Monad's RPC rejects `eth_getLogs` over 100 blocks | `maxLogRange` per network in config — never hardcode a span. |
| `forge test` needs `via_ir` | Already set; ERC-8004's 11-arg event overflows the stack without it. |

### Standing rules — do not re-derive these

- **Testnet only.** Any mainnet action needs explicit per-action confirmation.
- **Never create a git repository or a remote.** The three that exist were
  created by the user.
- **Private keys never leave `.env`.** Never in chat, never in `.env.example`
  (which is tracked), never in a log.
- **`AGENT_MODE=cached` by default.** Ask before any run that spends the
  user's API quota.
- **A mock that agrees with your assumptions proves nothing.** Every
  milestone gets a live-chain check.
- **Run a new test against the old code first.** If it passes either way it
  proves nothing — this caught four defects that unit tests had missed.

### In-flight work right now

**None.** All three repos are clean and fully pushed as of 2026-09-25. There
is no half-finished edit, no stashed change, no branch to reconcile. A fresh
session can start from the Next actions list at the top of this file.

---

## 📋 Facts & Config

**Fill these in as they arrive.** Everything downstream reads from here, and
this is the first thing a fresh session needs.

### Repos

| Repo | URL | Status |
|---|---|---|
| `agentx-contracts` | `git@github.com:gopaltalaviya/agentx-contracts.git` | ✅ **pushed** `5aa81a9` |
| `agentx-backend` | `git@github.com:gopaltalaviya/agentx-backend.git` | ✅ **pushed** `199dfe6` |
| `agentx-interface` | `git@github.com:gopaltalaviya/agentx-interface.git` | ✅ Next.js 15, 3 pages, `3503688` |
| GitHub owner | `gopaltalaviya` | ✅ |
| Commit author name | `gopaltalaviya` | ✅ |
| Commit author email | `58229620+gopaltalaviya@users.noreply.github.com` | ✅ |

> **Third repo is `agentx-interface`, not `agentx-web`.** All docs renamed
> 2026-09-22 to match. Access is SSH (`git@github.com:…`), so pushes need an
> SSH key loaded on this machine.

**Git dependency form** (D1 — no registry needed):

```jsonc
"@agentx/contracts": "github:gopaltalaviya/agentx-contracts#v0.1.0"
```

> ⚠️ **Claude does not run `git init` or `git remote add`** — the global
> instruction in `~/.claude/CLAUDE.md` forbids creating repositories and
> remotes. You run those three commands once per repo; Claude commits and
> pushes normally afterwards.

### Monad — verified 2026-09-22 by web lookup

> ⚠️ **Still confirm these yourself against docs.monad.xyz before deploying.**
> Verified from the official docs and Chainlist, but a chain config is the one
> thing worth double-checking with your own eyes.

**Testnet** (chain ID **10143**)

| Key | Value | Status |
|---|---|---|
| Chain ID | `10143` | ✅ |
| RPC URL | `https://testnet-rpc.monad.xyz` | ✅ |
| Explorer | `https://testnet.monadexplorer.com` (also `testnet.monadscan.com`) | ✅ |
| Faucet | `https://faucet.monad.xyz` | ✅ |
| Native currency | `MON` | ✅ |
| Faucet daily limit | `_______` | ⬜ you check |
| Verification: API key needed? | `_______` | ⬜ you check |
| Canonical USDC on testnet | `_______` (likely none → MockUSDC) | ⬜ you check |

**Mainnet** (chain ID **143**) — live, `v0.15.2 / MONAD_NINE`

| Key | Value |
|---|---|
| Chain ID | `143` |
| RPC URLs | `rpc.monad.xyz`, `rpc1`–`rpc3.monad.xyz`, `rpc-mainnet.monadinfra.com` |
| Explorers | `https://monadvision.com`, `https://monadscan.com` |
| Wrapped MON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` |

### ✅ RESOLVED: testnet first, both networks supported

**Decided 2026-09-22.** Ship and demo on **testnet (10143)**. **Mainnet (143)
is supported by the same code from day one** — the network is configuration,
never a code path.

What that buys, beyond covering the "MonadChain (ID: 143)" ambiguity on the
hackathon site: if mainnet turns out to be required, or you simply want to
show a mainnet transaction in the video, it is `make deploy-mainnet` plus one
env var. Not a migration.

Design: [08 — Configuration Architecture](docs/08-configuration.md).

Still worth asking the organisers whether mainnet is required — but it is no
longer a blocker, only a deploy target.

### Wallets — addresses only, never keys

| Role | Address | MON (checked Sep 23) |
|---|---|---|
| `DEPLOYER` | `0xd5b812EFb94124E737c3520739d04539a8441137` | **1.0** ✅ |
| `FUNDER` | `0x5c03DB6fb41c0F42777dDE051d07EAb9F54fCc54` | 0 — fund from DEPLOYER |
| `AGENT_A` | `0xfB95885d3A72A82836f3fCAC720Bf80A4155F6c2` | 0 — fund from DEPLOYER |
| `AGENT_B` | `0x2Ff72eE6B8de27dD8F2D9FbFf7102EfbaD8D37D6` | 0 — fund from DEPLOYER |

> **The faucet cannot be automated.** `faucet.monad.xyz` runs a bot-detection
> check and gates larger drips behind X/Discord linking. Claude does not
> complete bot-detection challenges. It is also unnecessary: 1 MON is ample for
> testnet, so DEPLOYER distributes to the other three with `cast send`.

### Deployed contracts

> Do not maintain this table by hand. It is a **copy for reading**; the real
> source is `deployments/<chainId>.json`, generated by the deploy script
> ([08 §4](docs/08-configuration.md#4-deployments--deploymentschainidjson)).

**ERC-8004 registries — verified on-chain 2026-09-22**

| Registry | Mainnet 143 | Testnet 10143 |
|---|---|---|
| Identity | ✅ `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` — ERC-721 `AgentIdentity` / `AGENT` | ❌ **not deployed** |
| Reputation | ✅ `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | ❌ **not deployed** |
| Validation | *coming soon* | — |

Both mainnet registries are **ERC-1967 upgradeable proxies**; Identity
implementation is `0x7274e874ca62410a93bd8bf61c69d8045e399c02` — pin it and
CI-check it has not moved (M1-00d).

> **Because they are absent on testnet, we deploy the open-source reference
> implementation there ourselves** (M1-00c). Config handles it: the `erc8004`
> block in `deployments/<chainId>.json` is per-chain, so testnet points at our
> deployment and mainnet at the canonical one, with identical code.
> Rationale: [09 §8](docs/09-landscape.md#8-m1-00-verification--results-2026-09-22-on-chain)

**Ours, once M1-19 runs:**

| Contract | Testnet 10143 ✅ LIVE | Mainnet 143 |
|---|---|---|
| `TaskEscrow` | `0x1b0959dfd32323e5a4749d5444c2e6435349027c` | ⬜ not deployed |
| `StakeVault` | `0x03d5429d352a98d1163a55ab97d733fbf534c322` | ⬜ |
| `AgentAccountFactory` | `0x51F75C30563d260FafF7dAB42ACf9fA57B82315D` | ⬜ |
| `MockIdentityRegistry` | `0x784b42fe1307c70e61df82288f9084614a0ce4c0` | canonical `0x8004A1…` |
| `MockReputationRegistry` | `0x0ab928f0c62a8a357a5f18caa1c0847c3b1ba697` | canonical `0x8004BA…` |
| Payment token (MockUSDC) | `0x1640c8ea1353c615783c09da4c51fcb457684a64` | ⬜ canonical USDC |
| `startBlock` | 65027889 | — |

> `AgentAccountFactory` was **redeployed 2026-09-24** (was
> `0x580f093c…`) to pick up `AgentAccount.MAX_SESSION_KEY_TTL`. It is
> standalone — `TaskEscrow` and `StakeVault` do not reference it, so nothing
> else moved. No `AgentAccount` instances exist yet: the signer uses an EOA
> under its own policy checks.

> Addresses are **generated** into `deployments/10143.json`; this table is a
> copy for reading. The escrow was redeployed twice during the adversarial
> pass, so trust the file, not a number pasted anywhere.

~~`AgentRegistry`~~ ~~`ReputationRegistry`~~ — **not built**; ERC-8004's are
used instead ([09](docs/09-landscape.md)). Fallback specs retained in
[04 §2.1 / §2.3](docs/04-how-it-works.md).

### Services

| Service | URL | Status |
|---|---|---|
| Railway project | `_______` | ⬜ not created |
| API | `_______` | ⬜ runs locally on :8080 |
| MCP endpoint | stdio (`apps/mcp`) | ✅ built — stdio, not hosted |
| Vercel web | `_______` | ⬜ not created |
| Local Postgres | `127.0.0.1:5442` | ✅ docker, migrated |
| Local Redis | `127.0.0.1:6381` | ✅ docker |

> Ports are deliberate: 5432 and 6379 were already taken on this machine by
> other projects, and a native Postgres on 5432 silently shadowed the
> container once already. `127.0.0.1` rather than `localhost`, because Node 24
> resolves `localhost` to `::1` while Docker binds IPv4.

---

## 📦 Complete status — 2026-09-25

Everything built and everything outstanding, by area. `✅` done and verified ·
`🟡` built but unproven · `⬜` not started · `👤` needs you.

### 1. Development

#### Contracts — `agentx-contracts` · ✅ complete, deployed

| Piece | State |
|---|---|
| `TaskEscrow` | ✅ job state machine, escrow + `directPay` fast path, three permissionless exits, sole writer of settlement-backed feedback |
| `StakeVault` | ✅ bonds per ERC-8004 `agentId`, withdrawal delay, slashing role-gated |
| `AgentAccount` | ✅ on-chain per-task and daily caps, target + selector allowlists, session keys capped at 24h |
| `AgentAccountFactory` | ✅ ERC-1167 clones, CREATE2 deterministic |
| `MockUSDC` | ✅ 6-decimal test token |
| `MockERC8004` | ✅ reference Identity + Reputation registries for testnet, where the canonical ones do not exist |
| Scripts | ✅ `Deploy.s.sol`, `verify-erc8004`, `check-config`, `write-deployment`, `export-abis`, `check-no-secrets`, `fund-wallets` |

Deliberately **not built**: `AgentRegistry` and `ReputationRegistry` — ERC-8004's
are used instead. Two contracts were deleted from the original design.

#### Backend — `agentx-backend` · ✅ built

| Package | State |
|---|---|
| `@agentx/config` | ✅ the one import for chain facts; validated and frozen at boot |
| `@agentx/shared` | ✅ zod schemas, error codes, `validateShape` |
| `@agentx/db` | ✅ Drizzle schema + 3 migrations; `runs` / `run_events` added for the demo page |
| `@agentx/sdk` | ✅ typed client incl. `network()`, `budget()`, `listJobs()`, SSE subscribe |
| `@agentx/agent-core` | ✅ brains + fallback chain, frozen prompts, `Judge`, `Worker`, `Orchestrator`, `runWorker` |

| App | State |
|---|---|
| `apps/api` | ✅ agents, jobs, meta (`/v1/network`, `/v1/budget`), runs, SSE, RFC 7807 errors, rate limits, idempotency |
| `apps/signer` | ✅ the only process with a key; on-chain policy mirrored, advisory-locked nonces, failed broadcasts retryable |
| `apps/indexer` | ✅ reorg-aware, replay-safe, exponential backoff, clean shutdown |
| `apps/mcp` | ✅ eight MCP tools over stdio; spend warnings and untrusted-result warnings enforced structurally |
| `apps/agents/*` | ✅ `orchestrator` + `research-bot`, `trading-bot`, `execution-bot` |
| `scripts/` | ✅ `e2e.mjs`, `demo.mjs`, `verify-indexer`, `verify-keystore`, `check-no-secrets` |

#### Interface — `agentx-interface` · 🟡 built, never viewed

| Page | State |
|---|---|
| `/` live demo | 🟡 goal box, SSE trace, running totals, explorer link on every on-chain line |
| `/agents` marketplace | 🟡 grid + the four ranking modes; unproven agents labelled, not scored |
| `/agents/[id]` profile | 🟡 what the reputation is actually made of |
| `/register` | 🟡 ERC-8004 identity first, then the AGENTX record, key shown once |
| `NetworkBadge` | 🟡 testnet vs REAL FUNDS; never assumes testnet when the API is unreachable |
| `pnpm check:contract` | ✅ verified against live testnet, 10 field groups |

**Pending development**

| | Item | Owner |
|---|---|---|
| ⬜ | x402 facilitator (P2 stretch — first to be cut) | 🤖 |
| ⬜ | Runs history page — `/v1/runs` exists, nothing renders it | 🤖 |
| 🟡 | Whatever the first real `pnpm demo` exposes | 🤖 |

### 2. Setup

| | Item | Detail |
|---|---|---|
| ✅ | 3 GitHub repos created, cloned, all pushed | `gopaltalaviya/agentx-{contracts,backend,interface}` |
| ✅ | Per-repo SSH identity pinned via `core.sshCommand` | after the global config silently fell through to the wrong key |
| ✅ | git identity set per repo | `gopaltalaviya` |
| ✅ | Pre-commit secret scanning in contracts + backend | tightened Sep 24 after it fired on ordinary English |
| ✅ | 4 wallets created and funded | DEPLOYER holds ~1 MON and distributes |
| ✅ | Docker Postgres 16 + Redis 7 | `127.0.0.1:5442` / `:6381` |
| ✅ | DB migrated | `0000`, `0001_constraints`, `0001_sudden_morlocks` (runs) |
| 🔴 | `agentx-backend/.env` | **does not exist** — blocks every live agent run |
| ⬜ | Railway project + services | 👤 |
| ⬜ | Vercel project | 👤 |
| ⬜ | Repos made public | 👤 — required by Oct 13 |

### 3. Configuration

| | Item | Detail |
|---|---|---|
| ✅ | `config/networks.json` | 3 chains: 31337, 10143, 143 |
| ✅ | `config/params.<chainId>.json` | 9 parameters each, identical shape |
| ✅ | `deployments/10143.json` | generated, live |
| ✅ | `deployments/31337.json` | local |
| ✅ | ABIs exported to `export/` | consumed by the backend |
| ✅ | Env split enforced | secrets only; no contract address is ever an env var |
| ✅ | `check-config.mjs` | green — 3 networks, 3 parameter files |
| ✅ | `AGENT_MODE` / `BRAIN_CHAIN` | `cached` by default, so development spends nothing |
| ⬜ | `deployments/143.json` (mainnet) | not deployed, and not needed for the submission |
| ⬜ | `ARBITER_ADDRESS`, `FEE_RECIPIENT` | default to DEPLOYER — 👤 to decide |
| ⬜ | Railway / Vercel env vars | 👤 |

### 4. Testing

| Suite | Count | State |
|---|---|---|
| Contracts — unit, fuzz, invariant, adversarial | **120** | ✅ green; 100% branch on `TaskEscrow` + `StakeVault` |
| Backend — 13 files | **179** | ✅ green |
| Interface | 0 | 🟡 `tsc --noEmit` and `next build` clean; no test suite |
| **Total** | **299** | |

**Verified against the real chain, not a mock**

| | Check |
|---|---|
| ✅ | `scripts/e2e.mjs` — full stack, one real settlement, asserted on balances, the fee split and reputation |
| ✅ | `verify-indexer.mjs` against live testnet |
| ✅ | `check-api-contract.mjs` — 10 field groups against a running API |
| ✅ | `MAX_SESSION_KEY_TTL` read back on-chain after the factory redeploy |

**Chaos checklist — 4 of 7**

| | Item |
|---|---|
| ✅ | kill the indexer → no duplicate rows *(found a real bug)* |
| ✅ | RPC 500s → exponential backoff, no stuck job |
| ✅ | daily cap → clean 402 an agent can branch on |
| ✅ | malformed result → refused at the boundary *(found a real bug)* |
| ✅ | wallet out of MON → actionable error, retry recovers *(found a real bug)* |
| ⬜ | kill a worker mid-job → refund fires, orchestrator retries — needs a live run |
| ⬜ | phone hotspot → no baked-in timeout assumptions — needs a live run |

**Pending testing**

| | Item | Owner |
|---|---|---|
| 🔴 | `pnpm demo` — **never run**. This is M3's done-condition | blocked on the key |
| ⬜ | Interface opened in a browser — nothing has checked how it *renders* | 👤 / 🤖 |
| ⬜ | 3 clean rehearsal runs, timed under 3 minutes | after the key |
| ⬜ | Backup video recorded in `cached` mode | after the key |
| ⬜ | `e2e.mjs` against Railway rather than localhost | after Railway |

### 5. Defects found and fixed during hardening

Kept because the pattern matters more than the list: **five mitigations were
documented before they were built**, and one bug survived because a test had
encoded it.

| Severity | Defect | Found by |
|---|---|---|
| 🔴 | Every escrow job would have been **disputed** — the API stored the delivery envelope as `result`, so good work failed the required-field check | auditing docs §5 against the routes |
| 🔴 | An **indexer restart could manufacture reputation** — the bump was not idempotent, while replays are routine | chaos item 2 |
| 🔴 | The on-chain commitment was the **spec** hash, not the result hash — T4's claim was false | the same docs audit |
| 🟠 | A failed broadcast **burned the idempotency key forever**; topping up the wallet did not help | chaos item 7 |
| 🟠 | A malformed result was **stored and signed for**, despite a comment claiming it was validated | chaos item 4 |
| 🟠 | Session keys had **no lifetime bound**, though T7 claimed 24h — fixed on-chain and redeployed | security pass |
| 🟠 | T15's **SSRF guard never existed** — nothing fetches those URLs, so the threat does not apply, but the claim was wrong | security pass |
| 🟡 | The indexer retried a failing RPC every 2s forever — a retry storm against a rate limiter | chaos item 5 |
| 🟡 | The secret scanner fired on **ordinary English**, training everyone to bypass the hook that guards real keys | writing a README |
| 🟡 | Postgres 23505 reported "duplicate wallet" for **every** unique violation | tripping over it |

Earlier defects are recorded in the session log below; these are the ones since
the adversarial pass.

---

## 📊 Milestone board

| # | Milestone | Dates | Status | Done |
|---|---|---|---|---|
| M0 | Foundations | Sep 22–24 | ✅ done | 23 / 23 |
| M1 | Contracts | Sep 25–28 | ✅ done | 26 / 26 |
| M2 | Backend spine | Sep 29 – Oct 2 | 🟡 in progress | 21 / 25 |
| M3 | Agents + MCP | Oct 3–5 | 🟡 in progress | 12 / 15 |
| M4 | Frontend | Oct 6–8 | 🟡 in progress | 9 / 11 |
| M5 | Harden | Oct 9–11 | 🟡 in progress | 4 / 7 |
| M6 | Submit | Oct 12–13 | 🟡 in progress | 4 / 8 |

Status key: ⬜ not started · 🟡 in progress · ✅ done · 🔴 blocked · ⏭ deferred · ❌ cut

---

## ✅ M0 — Foundations (task detail)

Kept for the record. Per-task detail for M1 onwards lives in the session log
and in `PLAN.md`; the rolled-up state is the Complete status section above.

| ID | Task | Who | Status | Notes |
|---|---|---|---|---|
| M0-01 | Confirm deadline + submission format | 👤 | ✅ | Oct 13 2026 11:59 PM ET; Track 4 |
| M0-02 | Monad chain facts | 🤖 | ✅ | testnet 10143 / mainnet 143, verified Sep 22 |
| M0-02b | Testnet vs mainnet | 👤 | ✅ | **testnet first, both supported** |
| M0-03 | Create 3 GitHub repos | 👤 | ✅ | ✅ `gopaltalaviya/agentx-{contracts,backend,interface}` |
| M0-04 | Create + fund 4 wallets | 👤 | 🔴 | faucet.monad.xyz |
| M0-05 | Scaffold `agentx-contracts` | 🤖 | ✅ | ✅ Foundry + remappings + Makefile + CI; `forge build` green |
| M0-06 | Scaffold `agentx-backend` | 🤖 | ✅ | ✅ pnpm workspace + docker-compose + tsconfig; builds |
| M0-07 | Scaffold `agentx-interface` | 🤖 | ⬜ | ready, waiting on M0-03 |
| M0-08 | `MockUSDC.sol` + test | 🤖 | ✅ | ✅ `MockUSDC.sol` + 5 tests, all passing |
| M0-09 | `Deploy.s.sol` + Makefile | 🤖 | ✅ | ✅ `Deploy.s.sol` — network-agnostic, dry-run verified on 31337 |
| M0-10 | Deploy + verify MockUSDC | 👤 | ⬜ | |
| M0-11 | ABI export script | 🤖 | ⬜ | |
| M0-12 | Decide package registry (D1) | 👤 | ⬜ | timebox to 30 min |
| M0-13 | Publish `@agentx/contracts` v0.0.1 | 👤 | ⬜ | |
| M0-14 | Install in B + W, prove wiring | 🤖 | ⬜ | |
| M0-15 | `packages/shared` zod schemas | 🤖 | ✅ | ✅ `@agentx/shared` — JobSpec/JobResult/errors, zod-derived |
| M0-16 | `.env.example` × 3 | 🤖 | ✅ | ✅ `.env.example` (contracts repo) |
| M0-17 | `config/networks.json` | 🤖 | ✅ | ✅ `config/networks.json` — 31337 / 10143 / 143 |
| M0-18 | `config/params.<chainId>.json` × 3 | 🤖 | ✅ | ✅ `config/params.*.json` × 3, key-parity enforced |
| M0-19 | `foundry.toml` aliases + `Makefile NETWORK=` | 🤖 | ✅ | ✅ `foundry.toml` aliases + `Makefile NETWORK=` |
| M0-20 | `write-deployment.mjs` | 🤖 | ✅ | ✅ `write-deployment.mjs` — proven on a real anvil deploy |
| M0-21 | `@agentx/config` — validated, frozen | 🤖 | ✅ | ✅ `@agentx/config` — validated + frozen; 8 money tests pass |
| M0-22 | Fail-fast boot validation | 🤖 | ✅ | ✅ fail-fast boot check, negative-tested |

Full task list for every milestone: [PLAN.md](PLAN.md)

---

## 🧭 Decisions log

Append-only. Never rewrite a decision — supersede it with a new row.

| Date | # | Decision | Rationale |
|---|---|---|---|
| Sep 22 | — | 3 separate repos | Contracts must never enter a Vercel/Railway build container ([docs/06](docs/06-repo-structure.md)) |
| Sep 22 | — | You hold all keys; you run all deploys | No private key reaches this session or any repo |
| Sep 22 | — | Vercel (web) + Railway (backend + Postgres + Redis) | Indexer and signer are long-running; Vercel cannot host them |
| Sep 22 | — | Claude writes code; you review, run, decide scope | |
| Sep 22 | — | Standard conventions everywhere | Conventional Commits, semver, `main` + short branches, tool defaults, no bespoke rules |
| Sep 22 | D1 | **Resolved: git dependency.** GitHub Packages forces the npm scope to equal the GitHub owner, which would rename `@agentx/contracts` to `@<owner>/contracts`. A git dep keeps the name, needs no registry setup | ✅ |
| Sep 22 | D2 | **Resolved: yes, public.** Submission rules require "a link to the code" | ✅ |
| Sep 22 | — | Target **Track 4 — Trust, Identity & AI Infrastructure** ($30k) | Track description names "agent trust" and "agent reputation systems" |
| Sep 22 | D6 | **Resolved: testnet first, both networks supported.** Network is config, never a code path | ✅ |
| — | D3 | Protocol fee paid by worker or client | ⬜ open — needed Sep 26 (rec: worker) |
| — | D4 | Name `AGENTX` available? | ⬜ open — needed Sep 25 |
| — | D5 | Demo domain | ⬜ open — needed Oct 6 |
| Sep 23 | M1 | **Agent models: orchestrator `claude-opus-5`, workers `claude-haiku-4-5`.** Planning and result-judgement are where a weaker model shows, and they are the visible part; workers do schema-constrained extraction, which Haiku handles 5x cheaper and faster (~$0.02/run vs ~$0.15) | ✅ |
| Sep 23 | M2 | **`AGENT_MODE=cached` is the development default.** One live run seeds the cache; Claude asks before any further live run. Dev cost ~$0.10 rather than ~$4–30 | ✅ |
| Sep 23 | C1 | **Resolved: encrypted keystore in a Railway env var**, passphrase in a separate var. Signer is built against a `Signer` interface so KMS can replace it without touching call sites. Documented as a known limitation in the submission | ✅ |
| Sep 23 | M3 | **The injection claim is bounded, not absolute.** "We do not prevent prompt injection; a successful one cannot spend more than the on-chain daily cap or pay a non-allowlisted address." Layer 4 is arithmetic, the rest is mitigation. No keyword filtering — it fails to paraphrase while manufacturing the look of safety | ✅ |
| Sep 23 | M3 | **System prompts are frozen module constants.** A prompt cache is a prefix match; one interpolated value invalidates every call. Dynamic context goes in the user turn. Enforced by a test, not a convention | ✅ |
| Sep 23 | M3 | **A failed judgement neither pays nor disputes.** Paying on an unread result rewards a worker for our outage; disputing punishes them for it. The escrow's review window settling in their favour is the only neutral option | ✅ |
| Sep 23 | M3 | **BUDGET_EXCEEDED is never retryable**, despite carrying a reset time. A cap is the owner's decision; an agent reports hitting it rather than sleeping until it lifts | ✅ |
| Sep 28 | M6 | **Name ERC-8183 in the submission rather than let a judge find it.** It standardises the job-escrow layer AGENTX independently built (Open → Funded → Submitted → terminal, permissionless refund). Positioning moves from "an escrow for agents" to settlement-backed reputation plus the bounds a spender needs — caps, stake, disputes — which 8183 leaves unspecified | ✅ |
| Sep 28 | M6 | **Lead with the published numbers.** Xiong et al. 2026 measured the live ERC-8004 ecosystem: $0.0027 median to move a score on Base, 90.6% of reviewers Sybil, 98.7–100% of feedback with no payment proof. Their first recommendation is evidence-backed interactions — which is what this project is | ✅ |
| Sep 28 | M6 | **Mapping TaskEscrow onto the ACP Job interface is post-hackathon.** Obvious next step, explicitly out of scope with 15 days left and the demo not yet run end to end | ✅ |

---

## 📓 Session log

Newest first. One entry per working session, however short.

### Session 20 — 2026-09-28 (docs 05/08 audit · a real race · CI · interface tests)

**Shipped** — backend `c5ab57e` · contracts `e9409a5` · interface `532823e`.
179 + 120 + 7 = **306 tests green**.

Three days idle. Nothing had changed: repos clean, `.env` still absent, so
`pnpm demo` remains blocked. **15 days to the deadline.**

**🔴 A flaky test was a real race.** One failure in four full suite runs:
`runs.test.ts > the trace > survives the run and is readable afterwards`. The
run row was set to `done` *before* the terminal `finished` event was recorded,
so anything reading the trace in that window got a story missing its ending —
the demo page, the SDK, anything polling `state`. The failure path had the same
ordering. Both now emit the terminal event first: state means complete, so
everything must be complete before it is set. Hammered after: 6 consecutive
runs of that file, 3 full suites, all green.

Rare is what made it dangerous — the kind of intermittent failure that gets
re-run until green and forgotten.

**docs/08 audit — `.env.example` was wrong in both directions**

- **Eight variables the code reads were undocumented**, including
  `AGENTX_API_KEY`, `AGENTX_API_URL` and `AGENTX_CHAIN_ID`. Without those
  nothing in `apps/agents/` starts, so anyone following the file could not
  have run a worker at all.
- **`API_JWT_SECRET`** implies a JWT mechanism that exists nowhere — auth is
  scrypt-hashed API keys. Removed.
- **`REDIS_URL` pointed at a Redis nothing imports.** No client, no
  dependency, and a compose service that would have become a paid Railway
  plugin connected to nothing. Removed, and what it was provisioned for is now
  written down as the limitation it is: rate limiting is per-process, so N
  replicas means N times the configured limit. Idempotency is unaffected — a
  `UNIQUE` constraint in Postgres, not an in-memory set.

One near-miss worth recording: `RPC_URL_10143` looked unused too, because it
is built as a template literal — `env[\`RPC_URL_${chainId}\`]`. A string grep
cannot see it. Checked before reporting.

**🟠 Contracts are NOT verified on the explorer.** An M1 done-condition that
was never met: `EXPLORER_API_KEY` is empty, so a judge following an explorer
link today sees bytecode, not source.

Chasing it found a config defect: every `[etherscan]` entry is validated when
forge starts, whichever verifier a command asks for, and ours had a key and a
chain id but no `url` — so **every** `forge verify-contract` failed with "No
known Etherscan API URL for chain 143", including ones explicitly passing
`--verifier sourcify`. Fixed. Sourcify does support Monad Testnet (confirmed
against its chain list), but forge's sourcify flow still reads the ABI from the
block explorer first, which needs a real key. **Yours to obtain.**

**Added:** interface tests — it had none. `formatUnits` is the only
money-handling code there, and the case that matters asserts exactness past
2^53, since a uint128 amount is far larger than a JS number can hold. Wired
into CI.

**docs/05** now carries a banner saying it is the plan as written, not the
record, and names the three things that turned out differently.

**Later the same day — research refresh and the deck.**

- **docs/09 §10** added: the published ERC-8004 study (Xiong et al. 2026) and
  ERC-8183 Agentic Commerce. Both change the pitch; see the decisions log.
- **Submission deck drafted** — 10 slides, at
  `https://claude.ai/artifact/MGoyMNdeQoYViNRGCCZS3a`. **Private**: judges
  cannot open it until you share it from the page's Share menu.

  Order: cover · the measured problem · the idea in one line · the four steps ·
  what is live on chain · the injection risk · the bounded claim · where it
  sits among the standards · what it does not solve · close with repo links.

  Two things it deliberately does not have yet: **a demo slide** (nothing has
  run end to end, and a screenshot of an unrun demo would be a lie) and any
  figure from a live run. Both land the moment the model key does.

**Next**

- You: the model key; an explorer API key if you want verified source; and
  share the deck if you want anyone else to see it.
- Me: the demo slide and real figures once the key lands; docs 01–04 and 07
  still unaudited.

### Session 19 — 2026-09-25 (full recheck · CI · doc 06 audit)

**Shipped** — backend `f58dca1`, `ebb208f` · interface CI. 179 tests green.

**The full recheck.** Repos clean and matching their remotes, 120 + 179 tests
green, interface builds, secret scans clean, config integrity OK, all seven
contracts confirmed to have code on-chain, `MAX_SESSION_KEY_TTL` reading 86400
live, `PROGRESS.md` addresses matching `deployments.json`, board sums matching
the header, doc links resolving, the interface↔API contract holding against a
live API, and `pnpm demo` correctly refusing to spend without a model.

**🔴 The live-chain check was lying in three ways.** `verify-indexer.mjs`:

- Its `specHash` was a **constant**, so every run ever made emitted the same
  hash on-chain and the indexer legitimately linked a fresh row to an older
  run's payment. It reported "the linkage is broken" when the linkage was
  fine. Same defect the API fixed by scoping its hash to a job id.
- It replayed from the deployment block, now ~500k blocks behind head. With
  Monad's 100-block cap that is thousands of round trips, so it never reached
  the settlement it had just made. Cursor now seeded just behind it: 1 tick.
- **Worst: the catch-up line printed `✓` unconditionally.** A run that never
  caught up still reported success, then failed three assertions with a
  misleading cause. A check that can report success while failing is worse
  than no check.

Now genuinely green on live testnet: linked to on-chain job 7, settled,
reputation counted once, replay a no-op, reorg rewind clean.

My own verification tooling also lied twice in one session — the on-chain
code check reported all seven contracts missing because `cast` was eating the
loop's stdin and Python had written CRLF into the address list.

**Doc 06 audit — almost every convention it described was fiction**

| Claimed | Reality |
|---|---|
| `packages/` has shared + db | five: config, shared, db, sdk, agent-core |
| `railway.json`, `CHANGELOG.md`, ESLint config | none of them exist |
| `pnpm --filter api start` | matches nothing; the package is `@agentx/api` |
| `mcp` is a Railway service | it speaks stdio; hosting it needs a transport it lacks |
| branches + PRs required on main | 27 direct commits, no branches, no PRs |
| CI in every repo | only contracts had any |

`pnpm lint` was declared but no ESLint config or dependency ever existed, so
it failed on every invocation. Removed rather than left as a script that lies.

**Added CI** to backend and interface. The backend suite needs Postgres *and*
the contracts checkout — 6 of 13 test files read chain config from there — so
the cross-repo checkout is `continue-on-error` and the suite **skips rather
than fails** while that repo is private. A red badge meaning "the token is not
set yet" teaches everyone to ignore the badge, which is exactly the failure the
secret scanner had.

**Not verified:** the workflows have been pushed but never watched running —
no `gh` CLI here. YAML parses and the jobs are well-formed; that is all that
can be said from this machine.

**Next**

- You: the model key. Also worth a look: do the new CI runs pass on GitHub?
- Me: docs 05 and 08 drift audit, then the deck.

### Session 18 — 2026-09-25 (full status documentation pass)

No code changed. This session brought the file itself back into line with
reality, which it had drifted out of.

**Did**

- Rewrote the header, **Next actions** and **Blockers**. All three still
  described Session 13: "create 3 GitHub repos", "fund 4 wallets", a blocker
  cleared three days earlier. The file that says START HERE was the most
  out-of-date thing in the project.
- Added **📦 Complete status**, the rolled-up done/pending picture across
  development, setup, configuration and testing, with an owner on every
  outstanding item.
- Refreshed the deployed-contracts table with the real addresses, including
  the `AgentAccountFactory` redeploy, and the services table with what is
  actually running locally.
- Renamed the stale "Current milestone: M0" heading — M0 finished on Sep 22.
- Added **🔌 Cold start**: paths, the exact commands to get from nothing to
  green, how to run the stack locally, the eight environment traps that have
  each cost real time, the standing rules, and an explicit statement that no
  work is in flight. Every command in it was run and verified before it was
  written down.

**🔴 Found while writing it: the memory was not backed up — now fixed.**
`docs/`, `PLAN.md`, `PROGRESS.md` and `README.md` were in **no repository**.
Ten specification documents and the entire task plan existed in one folder, on
one machine, named `temp`. The code was safe on GitHub; the thinking behind it
was one `rm` away — and the notes are the part that cannot be reconstructed
from the code.

Your call: move them into `agentx-backend` (commit `45cce2e`). They go public
with it by Oct 13, which the submission requires anyway, and a judge reading
the threat model or the defect log is a good outcome rather than a risk. No
fourth repository was created.

Moving rather than copying, because two copies of a source of truth drift —
which is the exact failure this project keeps finding. The root README became
`docs/00-overview.md`; a five-line signpost is all that remains at the old
level. Every cross-document link was rewritten and checked: **0 broken**. It
also fixed a real one — this repo's README linked `../docs/10-llm-architecture.md`,
which was broken on GitHub because the repo contained no `docs/`.

**Where things stand**

97 / 115 tasks, 299 tests green (120 contracts, 179 backend), all three repos
clean and pushed.

**The honest read.** Every layer is built and tested in isolation, and the
one thing that has never happened is the whole loop running with a real
model. That matters more than the task count: the last four defects — a
disputed-by-default settlement path, reputation an indexer restart could
manufacture, a burned idempotency key, a spec hash committed where a result
hash was claimed — all lived on that path and all passed their unit tests
first.

**Learned / changed**

- Auditing documentation against code is currently finding more real bugs
  than writing new code is. Three of the last five defects were found by
  reading a doc and checking whether the code agreed.
- Five mitigations in this project were written up before they were built.
  Table entries now carry the date they were checked against code.

**Next**

- You: the model key. Everything else outstanding is scheduling, not risk.
- Me: finish the docs drift audit (05, 06, 08), then the deck.

### Session 17 — 2026-09-24 (chaos checklist, key-free items)

**Shipped** — backend `57d9840`, `9b8f1fd`. 167 backend tests green.

Two of the seven chaos items are closed, and the first one found a real bug.

**🔴 An indexer restart could manufacture reputation.** `job_events` and
`payments` were protected by unique keys; the reputation bump was not — it is
`completed + 1` and it ran whether or not the event was new. Replays are
*ordinary*: the cursor is written after a batch is processed, so any restart
mid-batch re-reads it, and every reorg deliberately rewinds 2x the
confirmation depth. So each replay credited the worker again with no payment
behind it, inflating the one number AGENTX claims only a settled payment can
write.

Fixed by making the event insert and its effects one transaction, with the
insert's own uniqueness deciding whether the body runs. Verified the old way:
4 of the 7 new tests fail without the change.

Also found in the same path: `payments.block_number` was hardcoded to 0 — a
payment row nobody could find again on the chain it came from.

**Indexer backoff.** The retry loop was a flat 2s forever. Against a
rate-limiting public RPC that turns a brief limit into a permanent one.
Now exponential, capped, ±20% jitter, instant recovery on first success,
escalating log level after five consecutive failures. Loop extracted with
time injected — 10 tests, milliseconds.

**Chaos checklist status**

| Item | State |
|---|---|
| kill worker mid-job → refund + retry | ⬜ needs a model |
| kill indexer 60s → no duplicate rows | ✅ **bug found and fixed** |
| daily cap → clean 402 | ✅ |
| malformed result → dispute, not crash | ✅ **refused at the boundary now** |
| RPC 500 for 30s → backoff, no stuck job | ✅ |
| phone hotspot | ⬜ needs a live run |
| out of MON → clear error | ✅ **bug found and fixed** |

**Learned / changed**

- My own test helper aborted *after* the call it expected to throw, so the
  loop spun for ten minutes before I noticed. Aborts belong in `finally`.

**Later the same day — the remaining key-free items** (backend `b2f82e7`,
175 tests green). Two more gaps between documented and actual behaviour:

- **A malformed result was stored and signed for.** The route comment claimed
  validation against the spec's `outputSchema`; only the envelope was checked.
  A worker could deliver none of the requested fields, the API stored it, an
  on-chain `submitResult` went out, and the client found out by paying gas to
  dispute. Now refused before anything is submitted. `validateShape` moved to
  `@agentx/shared` — worker, orchestrator and API had been one copy away from
  three.
- **A failed broadcast burned the idempotency key forever.** The signer claimed
  a nonce row before sending; if the send threw (no gas, RPC down) the row sat
  `pending` with no hash and every retry was refused as "in flight". Topping
  the wallet up would not have helped — the opposite of the recovery the
  checklist asks for. The row is now marked `failed` and a retry reclaims it
  **reusing the stored nonce**, so if the original did reach the mempool only
  one of the two can ever be mined.
- Broadcast failures became actionable errors: an empty gas wallet names the
  address to fund; an unreachable RPC says nothing was broadcast, so retrying
  is safe.

**M6 groundwork the same day** — contracts `3b087d1`, `f-sync` · backend
`7db227f`.

- Both READMEs rewritten against what actually exists. The backend one still
  described the apps as "in progress"; the contracts one had no clickable
  deployment. Added the live addresses, the security properties as *tested
  properties* rather than adjectives, and an explicit "what is not solved".
- Root README status block replaced — it still said implementation was blocked
  on creating the repos and funding wallets.

**🟡 The secret scanner was crying wolf.** Its BIP-39 pattern was "twelve or
more short lowercase words", and writing the README tripped it on the sentence
*"bug in this project passed its unit tests and was caught only against the
real"*. The false positive matters less than what it teaches: a check that
fires on prose in every markdown file is one people learn to pass with
`--no-verify`, and the same hook guards the private keys that nearly reached a
tracked file in session 13. Now: exactly 12/15/18/21/24 lowercase words, alone
on a line or inside a quoted or assigned value. Verified both directions — real
mnemonics bare, in an env var and in JSON still flag; the prose does not.

**🔴 The docs pass found the worst bug yet** — backend `b6bb59b`, 179 tests.

Auditing docs/04 §5 against the real routes, to fix the documentation, turned
up a defect that would have broken the demo's main path in front of judges.

`result` means the worker's **output** everywhere it is read — the worker
checks its output against the job's `outputSchema`, the API checks the same on
submission, the orchestrator checks it again before paying. The API stored the
whole envelope `{output, producedAt}` under that name. So a perfect delivery
came back with none of the requested fields at the top level, failed the
orchestrator's required-field check, and was **disputed**. Every escrow job
with an `outputSchema` — which is every job the orchestrator creates — would
have been refused payment.

The existing lifecycle test asserted `job.result.output.summary`. It encoded
the envelope shape instead of questioning it, which is part of why this
survived: **the test agreed with the bug.**

Two more in the same three lines:

- `resultHash` hashed the envelope, so identical content delivered twice
  produced different commitments because `producedAt` differed.
- The on-chain commitment was never the result hash. The encoder falls back to
  the spec hash when none is supplied and nothing supplied one, so the chain
  committed to **what was asked for** rather than to what was delivered —
  T4's claim was not true. Now computed before the transaction and passed
  through.

Also: the Postgres 23505 handler reported "an agent already exists for that
wallet" for *every* unique violation. A duplicate on-chain job id reported as
a duplicate wallet sends whoever is reading to the wrong table — it cost me
exactly that here. It now names the constraint that fired.

Docs 04 §5 corrected: the staking endpoint never existed (owners bond via
`StakeVault.deposit` directly — the API has no custody), `/v1/agents/{id}/jobs`
is really `/v1/jobs?role=`, the result body is `{output, producedAt}`, and the
network/budget/runs/health endpoints were entirely undocumented.

**Next**

- You: a free model key in `agentx-backend/.env`. The three remaining chaos
  items and the backup video all need a live run.
- Me: finish the docs drift pass (05, 06, 08 still unaudited), then the deck.

### Session 16 — 2026-09-23 (register page · security pass T1–T17)

**Shipped** — contracts `5c7159a` · backend `2851876`, `baf177a` · interface `794423b`

- [M4] Register-an-agent page: ERC-8004 identity on-chain first, then the
  AGENTX record, then the key shown once.
- `/v1/network` now states the registry ABI variant and the public RPC list.
- [M5] Security pass of the full threat table against the code.

120 contract tests · 150 backend tests · interface builds clean.

**The security pass, T1–T17.** Thirteen claims hold and are marked verified
with the date. Three did not:

- **T7 — session keys "expire in 24h" was not enforced.** `grantSessionKey`
  accepted any expiry, including `type(uint64).max`. Fixed in the contract:
  `MAX_SESSION_KEY_TTL = 1 days`, checked on grant, past expiries rejected.
  `AgentAccountFactory` redeployed to
  `0x51F75C30563d260FafF7dAB42ACf9fA57B82315D`; ceiling confirmed live.
  TaskEscrow and StakeVault do not reference the factory, so nothing else
  moved and no AgentAccount instances existed.
- **T15 — claimed an SSRF guard that never existed.** Nothing fetches
  `metadata_uri` or `endpoint_url`, so the threat does not apply as built —
  a stronger position than the one claimed, but a guard described as present
  is how the next person adds a fetch believing they are covered. The schema
  columns now say so where someone would look.
- **T8 / T12 — mechanisms described imprecisely.** The signer dedupes on the
  Idempotency-Key it is given, not on `hash(agentId, specHash, worker)`; and
  there is one governance-set payment token, not an allowlist.

**Decided**

- **The contract enforces the bound rather than the doc describing it.** A
  time limit that depends on the caller passing the right number is not a
  control. Redeploying was cheap because the factory is standalone.
- **Registration is identity-first.** The API leaves `chainAgentId` NULL until
  an indexer confirms, and a hire is refused until both sides are known — so
  creating the record first hands someone a working key for an agent that
  quietly cannot be hired.
- **viem + injected wallet, not wagmi/RainbowKit.** RainbowKit needs a
  WalletConnect project id: another account to create and another key to keep
  alive days before a deadline. Trade-off stated in the README — injected
  wallets only.
- **`/v1/network` publishes the PUBLIC rpc list**, never the resolved
  `chain.rpcUrl`, which `RPC_URL_<chainId>` may have replaced with a keyed
  endpoint. There is a test asserting a configured secret never appears.

**Learned / changed**

- Second time a mitigation was documented before it was built. The first
  (T12's balance-delta guard) was a real insolvency bug. Table entries now
  carry the date they were checked against code.

**Next**

- You: a free model key in `agentx-backend/.env` — still the only thing
  blocking `pnpm demo`.
- Me: the remaining chaos-checklist items that need no model, then deploy.

**Open questions**

- The interface still has not been looked at in a browser.
- `AgentAccountFactory` changed address; anything holding the old one is
  pinned to a factory without the ceiling. Nothing does today.

### Session 15 — 2026-09-23 (runs API · the interface)

**Shipped** — backend `b597a0e`, `255b49d` · interface `3503688` (first commit)

- [M4-06] Live demo page, built first. One box, then the trace: plan, hire,
  judge, settle — with an explorer link on every on-chain line.
- [M4] Marketplace with the four ranking modes; agent profile.
- New API: `POST /v1/runs`, `GET /v1/runs`, `/v1/runs/:id`, `/v1/runs/:id/events`
  (SSE), backed by `runs` + `run_events` tables.
- `pnpm check:contract` in the interface, verified against live testnet.

148 backend tests green; interface `tsc --noEmit` and `next build` clean.

**Decided**

- **Runs are persisted, not held in memory.** The demo page is the submission
  video: a run that vanishes on refresh cannot be re-watched, re-recorded, or
  shown to a judge who arrived late. Every event is written before it is
  published — the row is the record, the stream is a view of it.
- **Reading a run needs no key; starting one does.** The trace is the thing
  being demonstrated.
- **The run carries the caller's API key**, because the orchestrator acts as
  that agent and must spend under that agent's on-chain caps.
- **Runs execute inside the API process**, with the executor injected. A
  separate runner service would add a queue and a second deployment between
  the page and the thing it is showing — three ways for the demo to break, to
  avoid a scaling problem it does not have. The seam is explicit so that stays
  a choice.
- **`lib/api.ts` is a deliberate copy**, not an import of `@agentx/sdk`:
  importing across the repo line would mean publishing the SDK or giving a
  Vercel build a key to a private repo. The drift guard is
  `check-api-contract.mjs`, which asks a running API rather than trusting the
  copy.

**Learned / changed**

- Node's `fetch` keeps a socket pool, and on Windows a script aborts during
  teardown with a libuv assertion (0xC0000409 → shell exit 127). A contract
  check where every assertion passed was exiting non-zero and would have read
  in CI as a permanent failure. Rewritten on `node:http`. Worth remembering
  for any other script whose exit code is load-bearing.
- The event bus was keyed by a bare number. Adding runs would have delivered
  job 7's events to run 7's subscribers; now one bus instance per kind.

**Next**

- You: a free model key in `agentx-backend/.env` (`GEMINI_API_KEY` or
  `GROQ_API_KEY`). Still the only thing blocking the first `pnpm demo`.
- Me: register-an-agent page (wagmi), then the M5 hardening pass.

**Open questions**

- The interface has not been looked at in a browser — routes return 200 and
  the API contract holds, but nothing has verified how it RENDERS. Needs a
  visual pass before the video.
- Workers still have no on-chain decline; a declined offer expires into a
  refund. Correct, but slow to watch on stage.

### Session 14 — 2026-09-23 (LLM architecture · MCP · workers · orchestrator)

**M3 is code-complete except the live run.** `pnpm demo` exists and gates on
a reachable model before it writes anything to the chain.

**Shipped** — backend `1092949`, `885c9f9`, `277a7a9`, `5ebab92`

- [M3-02/03/04] `apps/mcp` — eight tools over MCP, tested through a real
  in-memory MCP session (23 tests), not just as data.
- [M3-05..08] `Worker` base + `research-bot`, `trading-bot`, `execution-bot`.
- [M3-09/10/11] `Orchestrator` with every failure branch, 18 tests.
- [M3-12] `pnpm demo`.
- New API: `GET /v1/network`, `GET /v1/budget`, `GET /v1/jobs`.
- `docs/10-llm-architecture.md`.

137 backend tests green, tsc clean.

**Decided**

- **The honest injection claim.** "We do not prevent prompt injection. A
  successful injection cannot spend more than the on-chain daily cap or pay a
  non-allowlisted address." Layer 4 is arithmetic; everything above it is
  mitigation. Keyword filtering is deliberately absent — it fails to
  paraphrase while manufacturing the appearance of safety.
- **Frozen system prompts.** A prompt cache is a prefix match, so one
  interpolated value invalidates every call. Dynamic context goes in the user
  turn. Enforced by a test.
- **Judging failure pays nobody and disputes nobody.** Our outage must not
  become the worker's problem, and must not buy them an unearned settlement.
  The review window expiring in their favour is the only neutral option.
- **BUDGET_EXCEEDED is not retryable** even though it carries a reset time. A
  cap is a decision the owner made; an agent should report hitting it, not
  sleep for a day.

**Learned / changed**

- Three tools in the spec had no endpoint behind them (`my_budget`,
  `get_network`, and a worker's ability to learn it was hired at all). Writing
  the MCP layer is what surfaced it — the spec had been read as implemented.
- `resetsInSeconds` was nearly wrong: `AgentAccount` rolls 24h from `dayStart`,
  not UTC midnight. The signer's existing `Retry-After` uses midnight and is
  the same mistake, still open (see below).
- A test file imported for a fixture re-runs its whole suite. Fixtures moved
  out of `.test.ts`.

**Next**

- You: a free model key in `agentx-backend/.env` — `GEMINI_API_KEY` (no card)
  or `GROQ_API_KEY`. It blocks the first `pnpm demo`, which is M3's done
  condition and the M5 backup video.
- Me: M4 once the demo has run — live demo page first.

**Open questions**

- `apps/signer/src/signer.ts` reports `Retry-After` for BUDGET_EXCEEDED from
  UTC midnight, but the contract's window is rolling. Small, worth fixing
  before M5.
- Workers have no on-chain "decline"; a declined offer simply expires into a
  refund. Correct, but slow to watch. Consider whether the demo should show it.

### Session 13 — 2026-09-23 (API · testnet deploy · adversarial pass)

**AGENTX is live on Monad testnet.** Escrow
`0x1B0959Dfd32323E5a4749D5444C2E6435349027c`, startBlock 65027889.

**Shipped** — contracts `174031c` · backend `adf47e9`, `35979d0`, `0074f9b`

Fastify API (auth, discovery + ranking, job lifecycle, SSE, RFC 7807), the
testnet deployment, and an adversarial review that found five real defects.

**The five defects — four would have broken the live demo**

| # | Defect | Why it mattered |
|---|---|---|
| 19 | **Fee-on-transfer token broke solvency.** Escrow held 49,500 against a 50,000 job while `lockedTotal` counted the full amount | Invariant I1 broken — real insolvency, surfacing only when the last worker could not be paid. **T12 claimed this was already guarded. It was not.** |
| 20 | **`DirectPaid` carried no `specHash`** | The fast path was unlinkable, so every fast-path payment was dropped as "unknown job". The demo's *first* hire is a fast-path payment |
| 21 | Job could be created for an agent with a **zero payout wallet** | Client's money taken, settleable only by refund, worker's effort wasted |
| 22 | **`eth_getLogs` capped at 100 blocks on Monad**; hardcoded 2000 | An outright RPC error, not a slow query |
| 23 | API never advanced `jobs.state`; zod rejections returned 500 | Every second transition 409'd; agents could not tell "I sent nonsense" from "the server broke" |

**The lesson worth writing down**

Every one of these passed the unit tests. The API mock returned a
`chainJobId`, so 24/24 tests went green while the real pipeline was completely
inert. **Mocks agreed with my assumptions, so they confirmed them. The chain
did not.**

**Verified on the live chain, not simulated**

```
✓ directPay settled as job 1 in block 65027979
✓ indexer linked the job to on-chain id 1 via specHash
✓ job projected to state "settled"
✓ reputation: completed=1 failed=0 score=50
✓ replay is a no-op · reorg rewind clean
```

114/114 contracts (CI profile, 10k fuzz) · 100% branches on `TaskEscrow` and
`StakeVault` · 32/32 backend · 15 new adversarial tests.

**Security**
- Four testnet keys were pasted into `.env.example`, which is **tracked**.
  Caught in the working tree, never committed, never pushed, moved to `.env`.
  It survived on timing alone — my `git add -A` would have staged it.
- `check-no-secrets.mjs` now runs as a **pre-commit hook** in both repos and
  first in CI. Negative-tested.

**Next**
- `e2e.sh` through the full API stack on testnet, then M3 (MCP + agents)
- You: Anthropic API key with a spend cap, before M3

---

### Session 12 — 2026-09-23 (M2: signer)

**Shipped** — `agentx-backend` `ca12fb4`

The signer holds every key and does nothing else. On Railway it binds to
private networking only — an unauthenticated signing endpoint on the public
internet is not a risk worth taking.

Order of checks, cheapest first: idempotency replay → policy (read from the
*contract*, not our cache) → gas floor → nonce under a **Postgres advisory
lock**. An in-process mutex would not survive the second replica Railway will
happily give us. The `signer_txs` row is claimed *before* broadcasting, so a
crash in between leaves a visible pending row rather than an untracked
in-flight transaction.

**C1 implemented**: encrypted keystore in env, behind a `KeySource` interface
so KMS drops in later without touching call sites.

**Two bugs caught by testing against a keystore `cast wallet import` actually
produced**, rather than a hand-made fixture:

| # | Bug |
|---|---|
| 15 | `require` does not exist in an ESM module — the MAC path would have thrown on the first real key |
| 16 | **Node's `sha3-256` is not Keccak-256.** Different functions on the same sponge; using the former rejects *every* valid Ethereum keystore |

Bug 16 is the kind that only shows up when you feed real data in. A hand-made
fixture built with the same wrong assumption would have passed.

**Verified** (`pnpm verify:keystore`, self-contained — generates its own keystore)
- decrypts to the right key and address
- a wrong passphrase fails **loudly on the MAC**, rather than yielding a
  plausible-but-wrong key that would sign from an unfunded address
- per-agent maps resolve; an agent with no key gets `null`, never someone else's
- a keystore with no passphrase is rejected at boot

**Next**
- The Fastify API, then `e2e.sh` proving a hire settles end to end via curl
- You: 4 funded testnet wallet addresses

---

### Session 11 — 2026-09-23 (M2: indexer)

**Shipped** — contracts `8237d21` (ABI export) · backend `ff8a3be` (indexer)

The indexer is chain → Postgres, one worker per enabled chain, built around
being **re-runnable** (idempotency from the unique key, not from care) and
**reorg-aware** (the cursor stores the block hash; if the chain no longer
reports it, rewind and replay).

**`scripts/verify-indexer.mjs` drives anvil end to end and asserts on the
rows** — because unit tests cannot tell you whether the indexer decodes what
the contracts actually emit. It found three real bugs:

| # | Bug | Why it mattered |
|---|---|---|
| 12 | `REORG_DEPTH` hardcoded to 12 | A freshly started chain with 7 blocks indexed **nothing** — the safe head sat below block zero. Now derived from the network's declared `confirmations`: 1 local, 2 testnet, 5 mainnet |
| 13 | **Reputation double-counted on the fast path** | `directPay` emits `DirectPaid` *and* `JobSettled`; both bumped reputation, so every fast-path payment counted twice — inflating exactly the reputation this project claims is trustworthy |
| 14 | `createDb` opened a pool nothing closed | Scripts finished their work then hung forever, which looks identical to a deadlock. Added `closeDb` |

Bug 13 is the one that would have been embarrassing: the whole pitch is
"reputation you cannot fake", and the indexer was quietly doubling it.

**Verified**
```
settlement indexed          job_events: direct_paid, settled
job projected               state = "settled"
reputation                  completed=1 failed=0 score=50
one job is not perfect      score 50, volume damping working
replay across 3 ticks       no-op, 2 events before and after
corrupted cursor hash       rewind replayed, nothing duplicated
```

**Learned / changed**
- Two of my *test's* own bugs also surfaced: it raced the chain (the indexer
  correctly trails the head, so the settlement block was not yet safe), and it
  hardcoded `chainJobId = 1` while the escrow's counter persists across runs.
  Both now read real values instead of assuming them.
- Ports: another reminder that this machine is busy — 85 stray node processes
  accumulated from backgrounded builds during this session.

**Next**
- Signer (policy pre-check, nonce lock, idempotency, keystore per C1), then the API
- You: 4 funded testnet wallet addresses

---

### Session 10 — 2026-09-23 (M2: database layer)

**Shipped** — `agentx-backend` `f19c36e`

`@agentx/db`: Drizzle schema, generated migration, and a hand-written
constraints migration for what Drizzle cannot express.

**Every constraint tested by attempting the bad write** against a live
PostgreSQL 16 — not assumed from the DDL:

| Attempt | Result |
|---|---|
| Two agents sharing `chain_agent_id` on **different** chains | ✅ accepted — per-chain uniqueness works |
| The same pair on the **same** chain | ❌ `agents_chain_agent_uk` |
| Job with client on testnet, worker on mainnet | ❌ `jobs_worker_same_chain` |
| Self-dealing job | ❌ `no_self_dealing` |
| Capability `"Market Research"` | ❌ `capability_is_kebab_case` |
| Negative price · score 101 | ❌ both rejected |
| `UPDATE` / `DELETE` on `job_events` | ❌ append-only trigger |
| Replaying an already-indexed event | ❌ idempotency key |

That last pair is what makes the indexer safely re-runnable after a reorg:
replaying a block range becomes a no-op rather than a duplication.

**Learned / changed**
- **Port collisions with your other projects.** 6379 (`another-redis`), 6380
  (`another-project-redis`) and 5432 (a native Postgres shadowing `localhost`) were
  all taken. Moved to **5442 / 6381**. The Postgres one was the dangerous
  case: the container *appeared* healthy and bound the port, but `localhost`
  resolved to a different database — silently connecting to the wrong
  database is worse than failing to connect.
- `job_events` being append-only is now a **trigger**, not a convention. An
  audit log that the application can rewrite is not an audit log.

**Next**
- Indexer (chain → Postgres, reorg-safe), then signer, then the API
- You: 4 funded testnet wallet addresses

---

### Session 9 — 2026-09-23 (M1 contracts complete)

**Shipped** — `agentx-contracts` `be2efae`

`AgentAccount` + `AgentAccountFactory`, and `Deploy.s.sol` wired for the whole
protocol. **All contracts are now written.**

**The design decision that matters**

Spend is measured as the **actual token balance delta** across the call, not
decoded from calldata. Calldata decoding has to know every function signature
it might meet and silently misreads anything new; a balance delta cannot be
fooled by an unfamiliar call.

For that to be sound, `approve` can never be allowlisted — a standing
allowance would move funds outside every cap. So allowances are granted by the
owner through `setAllowance`, outside `execute`, where no session key reaches
them. `setAllowedSelector` refuses to allowlist `approve` at all, which makes
the in-`execute` guard dead by construction; it stays, documented, for the day
someone relaxes that setter.

**Other choices worth keeping**
- A session key can revoke **itself**, so a signer detecting its own compromise
  can disarm without waiting for a human.
- ERC-1167 clones: an agent wallet is ~45 bytes of deployed code, and its
  address is CREATE2-deterministic so it can be funded *before* it exists.
  The owner is bound into the salt so nobody can front-run another's address.
- The daily window rolls *before* it is tested, so a stale day never blocks work.

**Verified end to end on anvil**

```
deploy → 6 contracts incl. ERC-8004 reference registries (absent on this chain)
       → write-deployment.mjs → deployments/31337.json with a resolved erc8004 block
       → @agentx/config loads every address, formats 0.03 MockUSDC correctly
```

- **99/99 tests pass**
- 100% branch coverage on `StakeVault` and `TaskEscrow`
- `AgentAccount` at 82% branches — the gap is the one intentionally-dead guard

**Learned / changed**
- My `AgentAccount` cap tests silently passed through the *escrow's*
  `fastPathMax` guard instead of the account's caps, because 100k > 30k. The
  revert selector in `CallFailed(0x77931ab9)` gave it away. Tests now raise the
  escrow ceiling so they probe what they claim to.
- `write-deployment.mjs` looked for `IdentityRegistry` but the reference
  contracts compile as `Mock*`, so the `erc8004` block came out empty. Caught
  by reading the generated file rather than trusting the script.

**Next**
- M2: Drizzle schema → indexer → signer → API
- You: 4 funded testnet wallet addresses (still the only blocker)

---

### Session 8 — 2026-09-23 (M1 core contracts)

**Shipped** — `agentx-contracts` `5a626fb`

| Contract | Notes |
|---|---|
| `TaskEscrow` | Full state machine, all three permissionless exits, disputes, fast path, and the `giveFeedback` call that is the entire thesis |
| `StakeVault` | Bonds per ERC-8004 `agentId`, withdrawal delay, slashing that reaches pending funds |
| `MockERC8004` | Identity + Reputation mirroring upstream behaviour, with `setShouldRevert` so I8 is actually provable |

**Verified**
- **79/79 tests pass** under the CI profile (10,000 fuzz runs)
- **100% branch coverage on both `StakeVault` and `TaskEscrow`**
- 6 invariants hold over **2,048 randomised calls each** — including
  `lockedTotal` never drifting from the sum of open jobs
- `forge fmt --check` clean; gas snapshot committed

**Design decisions worth keeping**
- `autoApprove` means a client cannot take a result and withhold payment by
  going quiet. Together with `expireUndelivered` (worker took the job, never
  delivered) every non-terminal state has a permissionless way out.
- `workDeadline` is absolute from creation, so a worker knows its real deadline
  *before* accepting rather than after.
- Requesting a stake withdrawal **immediately** un-lists the agent — an agent on
  its way out should stop receiving work at once, not after the cooldown.
- Slashing reaches `pending` funds, so requesting a withdrawal is not an escape
  hatch from being slashed.
- Windows are clamped (`maxAcceptWindow`/`maxWorkWindow`). Without that a client
  could set a 1000-year deadline and lock its own funds past any refund.

**Learned / changed**
- `via_ir` had to be enabled: ERC-8004's 11-argument `NewFeedback` event
  overflows the stack otherwise. Build cost measured at ~6s — acceptable.
- Three of my own test bugs, all caught before pushing:
  `vm.prank` is consumed by the *next* call, so `vault.grantRole(vault.SLASHER_ROLE(), …)`
  ran as the test contract, not `admin`; event data with dynamic strings does
  not put the last field in the last word (`abi.decode`, not assembly); and
  `getRoleMemberCount` needs `AccessControlEnumerable`.
- `--ir-minimum` coverage misattributes some lines under `via_ir` — but two of
  the four it flagged were genuine gaps (disputing a non-submitted job,
  resolving a non-disputed one). Worth reading rather than dismissing.

**Next**
- `AgentAccount` + factory (M1-10…M1-12), then `Deploy.s.sol` wiring (M1-18)
- You: the 4 funded testnet wallet addresses — still the only thing gating a
  testnet deploy

---

### Session 7 — 2026-09-22 (M1-00b resolved · both repos pushed)

**M1-00b answered by reading the reference implementation**
(`erc-8004/erc-8004-contracts@master` — the default branch is `master`, not `main`)

✅ **`giveFeedback` is plain `external`.** No `tx.origin`, no `isContract`,
no EOA restriction. A contract *can* call it, and feedback is keyed by
`msg.sender`, so `TaskEscrow` becomes the client address `getSummary` filters
on. **The differentiator is viable exactly as designed.**

Three things came with that answer, two of which changed the plan:

| Finding | Consequence |
|---|---|
| `require(!isAuthorizedOrOwner(msg.sender, agentId))` | `TaskEscrow` must never own or be an operator of an agent it rates → new threat **T17** |
| `MAX_ABS_VALUE = 1e38` | Our 0–100 scale is far inside it |
| ❌ **`getSummary` reverts on an empty client list** | **Four docs were wrong.** There is no unfiltered ERC-8004 score |
| ❌ `getSummary` loops over every feedback entry per client | Won't scale for a single high-volume client address → score comes from indexed `NewFeedback` events instead |

The `getSummary` correction actually *strengthens* the pitch:

> ERC-8004 already forces every reader to name whose feedback they count.
> What it never gave them is an address worth naming. AGENTX is that address.

**Did**
- Step 0 of the M1 plan: corrected `README`, `01`, `02`, `04`, `09`; added T17
- Installed forge-std and OpenZeppelin as **git submodules** (Foundry standard,
  so CI's `submodules: recursive` works) — replacing the plain clones
- Wrote a README for each repo
- **Committed and pushed both repos**

**Verified before pushing**
- contracts: `forge build` clean · 5/5 tests · config integrity · erc8004 probe
- backend: `pnpm -r build` clean · 8/8 tests
- secret scan over staged diffs: clean; only `.env.example` present

**Learned / changed**
- `.gitignore` does **not** support trailing comments. `broadcast/    # ...`
  was treated as one literal pattern, so the anvil run artifacts got staged.
  Caught by reading `git status` before committing rather than after pushing.
- Added `.gitattributes` (`eol=lf`) to both repos — without it Windows CRLF
  would land in the remote and every future diff would be noise.

**Next**
- Step 1: `StakeVault`, then `TaskEscrow` (the core), then `AgentAccount`
- You: the 4 funded testnet wallet addresses — still the only thing gating a
  testnet deploy

---

### Session 6 — 2026-09-22 (Phase 2: backend config spine)

**Did**

| Task | Result |
|---|---|
| M0-03 | Repos received: `gopaltalaviya/agentx-{contracts,backend,interface}` |
| — | **Renamed `agentx-web` → `agentx-interface`** across all 6 docs to match the repo you created |
| M0-06 | `agentx-backend` pnpm workspace: `tsconfig.base.json` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), `docker-compose.yml` (PG16 + Redis7 with healthchecks) |
| M0-15 | `@agentx/shared` — `JobSpec`, `JobResult`, `HireRequest`, error codes, canonical JSON for `specHash` |
| M0-20 | `scripts/write-deployment.mjs` in contracts repo |
| M0-21 | `@agentx/config` — the one import; validated with zod, frozen |
| M0-22 | Fail-fast boot check + `bin/check.mjs` |

**Verified end-to-end, not assumed**

Ran a real local deployment and loaded it back through the config package:

```
anvil (chainId 0x7a69)
  → forge script Deploy --broadcast   → MockUSDC 0x5FbDB231…80aa3
  → write-deployment.mjs anvil        → deployments/31337.json (startBlock 1)
  → @agentx/config                    → "fastPath 0.03 MockUSDC · minStake 10 MockUSDC · fee 1%"
```

That is the whole single-source chain proving itself: `networks.json` +
`params.31337.json` + a **generated** deployment file → one typed, frozen
object. No address was typed twice anywhere.

- `pnpm -r build` → clean
- `vitest run` → **8/8 passing** (money arithmetic, fee invariant I4, frozen config)
- Config fail-fast **negative-tested**: with no deployment file it printed
  *"deployments/10143.json not found → run `make deploy NETWORK=monad_testnet`,
  or drop 10143 from ENABLED_CHAIN_IDS"* — the error names the fix

**Decided**
- Token amounts cross every boundary as **decimal strings of base units**, never
  JSON numbers. A `uint128` amount exceeds 2^53, so a JSON number would lose
  precision silently and the first symptom would be a payment that fails to
  reconcile. Tested explicitly at 2^53+1.
- `Capability` is constrained to lowercase kebab-case. Free-form strings make
  discovery unmatchable — "Market Research" and "market-research" would be
  different capabilities and no agent would ever be found.

**Learned / changed**
- My own test used `new URL(...).pathname`, which on Windows yields `/C:/…` and
  cannot be resolved by `fs`. Caught immediately **because the config error was
  actionable** — it named the path it had tried. Fixed with `fileURLToPath`.

**Blocked on you**
- `git init` + `git remote add` for each repo — your global instruction forbids
  Claude creating repositories or remotes. Three commands, then Claude commits
  and pushes normally.
- Funded testnet wallet addresses (B2) — still the only thing gating a testnet deploy.

**Next**
- Me: `check-param-drift.mjs`, `export-abis.mjs`, then **M1: `StakeVault` + `TaskEscrow`**
- You: the git commands, and the 4 wallet addresses

---

### Session 5 — 2026-09-22 (Phase 1: contracts repo foundation)

**Did — `agentx-contracts/` now builds and tests green**

| Task | Result |
|---|---|
| M0-05 | Foundry project: `foundry.toml` (multi-network aliases, deterministic `bytecode_hash = "none"` for CREATE2), `remappings.txt`, `Makefile`, CI workflow |
| M0-08 | `MockUSDC.sol` + 5 unit/fuzz tests — **all passing** |
| M0-09 | `Deploy.s.sol` — fully network-agnostic, reads `config/` at runtime; **dry-run verified** on chain 31337 |
| M0-17 | `config/networks.json` — 31337 / 10143 / 143 |
| M0-18 | `config/params.{31337,10143,143}.json` |
| M0-19 | `foundry.toml` aliases + `Makefile NETWORK=` |
| M1-00d | `scripts/verify-erc8004.mjs` — **written and passing** |
| — | `scripts/check-config.mjs` — config integrity, wired into CI |

**Verified, not assumed**
- `forge build` → Compiler run successful
- `forge test` → 5 passed, 0 failed
- `forge script Deploy --chain-id 31337` → reads config, deploys MockUSDC, prints the right params
- `node scripts/verify-erc8004.mjs` → exit 0, all expectations match
- `node scripts/check-config.mjs` → exit 0; **negative-tested** by deliberately breaking `params.143.json`, which produced exactly the two intended errors

**Decided**
- **D1 resolved: git dependency, not GitHub Packages.** GitHub Packages requires
  the npm scope to equal the GitHub owner, so `@agentx/contracts` would have to
  become `@<owner>/contracts`. A git dep keeps the name and needs zero registry
  setup. Consumers install `github:<owner>/agentx-contracts#v0.1.0`.

**Learned / changed**
- `forge fmt`'s `multiline_func_header = "params_first"` exploded every
  one-argument function onto three lines. Removed it — Foundry's default is
  the standard, which is what was asked for.
- `MockUSDC` deployment is now guarded **twice**: `check-config.mjs` rejects
  `deployWithProtocol: true` on a non-testnet, and `Deploy.s.sol` re-asserts it
  on-chain. The second check is redundant on purpose; that mistake is
  irreversible.

**Next**
- Me: `agentx-backend` scaffold, then the three remaining contracts scripts
- You: repo URLs (B5) and funded wallet addresses (B2)

---

### Session 4 — 2026-09-22 (landscape analysis → ERC-8004 pivot)

**Did**
- Researched the actual 2026 landscape: ERC-8004, x402, AP2, Virtuals ACP,
  Skyfire, Nevermined, Coinbase Agentic Wallets
- Wrote [09 — Landscape Analysis](docs/09-landscape.md)
- Repositioned the project and revised the contract architecture accordingly

**The finding that forced a pivot**

AGENTX as originally specced was **already built, twice**:

- Its identity + reputation registries are **ERC-8004**, which is *already
  deployed on Monad* (`0x8004A169…a432`, `0x8004BAa1…9b63`) and documented in
  Monad's own guides
- Its marketplace flow — discover, hire, escrow, evaluate — is **Virtuals
  ACP**, live on Base

In Track 4 (*Trust, Identity & AI Infrastructure*), a judge would have spotted
the ERC-8004 duplication within thirty seconds.

**The gap that is genuinely open**

ERC-8004 has **no payment primitive at all**, and its `giveFeedback()` is
callable by anyone — so reputation is free to forge. A published empirical
study of the live ecosystem (arXiv 2606.26028) found exactly that: coordinated
sybil registrations, reputation manipulation, dormant registries, and
"incomplete payment settlement mechanisms".

**New positioning**

> ERC-8004 gives agents identity and a place to record reputation. It does not
> give them money, and its feedback is free to forge. **AGENTX is the
> settlement layer that makes ERC-8004 reputation cost something.**

The mechanism is already in the standard: `getSummary()` takes a
`clientAddresses` filter, so a reader chooses whose feedback to count.
Filtering to `[AGENTX_ESCROW]` yields a score that **cannot be written without
a settled on-chain payment**. No fork, no migration, one-line adoption for any
ERC-8004 reader.

**Architecture changes**

| Change | Effect |
|---|---|
| ❌ `AgentRegistry.sol` — use ERC-8004 Identity | −1 day |
| ❌ `ReputationRegistry.sol` — write to ERC-8004 via `giveFeedback()` | −0.5 day |
| ➕ `StakeVault.sol` — the custody ERC-8004 lacks; answers the sybil finding | +0.5 day |
| ➕ ERC-8004 read adapter + agent-card generator | +1 day |
| ➕ x402 facilitator adapter (**P2, cut first**) | +1 day |
| ✅ `TaskEscrow` + `AgentAccount` unchanged — the parts nothing else has | — |

Net ≈ breakeven. Both fallback specs retained in
[04 §2.1 / §2.3](docs/04-how-it-works.md) in case M1-00 verification fails.

**Learned / changed**
- `AgentAccount`'s **on-chain** spending caps are now the strongest purely
  technical differentiator: Skyfire, Nevermined and Coinbase all do spend
  control off-chain and custodially.
- x402 has real adoption (~165M tx, ~$50M, Linux Foundation, Google/Visa/AWS/
  Circle/Anthropic members) but is **not on Monad**. Bridging to it is reach,
  not thesis — P2, cut first.
- The submission must claim the specific gap, not superlatives. The space is
  crowded and judges will know it.

**Next**
- 🔒 **M1-00 (Sep 25): verify ERC-8004 on Monad** — read both registries,
  confirm ABIs match the draft EIP, and confirm `giveFeedback()` accepts a
  **contract** caller. The whole design rests on that last one.
- You: M0-03 repos · M0-04 wallets

---

### Session 3 — 2026-09-22 (dual-network + config architecture)

**Did**
- Wrote [08 — Configuration Architecture](docs/08-configuration.md): the
  single-source-of-truth design for running testnet and mainnet off one codebase
- Corrected the database schema for multi-chain, updated the API, MCP, repo
  layout, tech stack and plan to match
- Added 10 tasks (100 → 110)

**Decided**
- **Testnet (10143) first; mainnet (143) supported by the same code.** The
  network is configuration, never a code path
- Four config domains, one owner each: `networks.json` (chain facts),
  `params.<chainId>.json` (protocol parameters), `deployments/<chainId>.json`
  (generated addresses), env (secrets and wiring only)
- **No contract address is ever an env var**, and no chain object is defined
  outside `@agentx/config`
- Constructor args stay network-independent so CREATE2 gives identical
  addresses on both networks; parameters arrive via post-deploy `configure()`

**Found and fixed — 3 more defects**

| # | Defect | Fix |
|---|---|---|
| 9 | **The schema could not hold two networks.** `chain_agent_id UNIQUE`, `chain_job_id UNIQUE`, `wallet_address UNIQUE` and `indexer_cursor PRIMARY KEY (contract)` are all global. Indexing a second chain would collide at agent #1 | `chain_id` on every chain-derived table; every uniqueness constraint scoped to it; cursor keyed `(chain_id, contract)` |
| 10 | Nothing prevented a job whose client is on one chain and worker on another | composite FKs `(agent_id, chain_id)` — structurally impossible, not merely checked |
| 11 | Protocol parameters existed **three times** (docs table, deploy script, backend pre-check) with nothing keeping them equal | one JSON per chain read by all three, plus a CI drift test against the deployed values |

**Learned / changed**
- Reputation must be **per chain**. Testnet MON is free, so a shared
  reputation table would make mainnet scores purchasable for nothing. This is
  a security property, not a schema detail.
- Mainnet parameters are deliberately more conservative than testnet — a
  10-minute auto-approve window is fine for a demo and indefensible against
  real funds.

**Next**
- You: M0-03 repos · M0-04 wallets
- Me: scaffolding + config packages, the moment repo URLs land

---

### Session 2 — 2026-09-22 (verification pass)

**Did**
- Verified all 99 task IDs: no duplicates, counts match the milestone board
- Verified every cross-document link and anchor; fixed 1 broken anchor
- Verified external facts by web lookup: deadline, tracks, prizes, Monad
  testnet (10143) and mainnet (143) config

**Found and fixed — 8 defects in my own spec**

| # | Defect | Fix |
|---|---|---|
| 1 | `scoreOf()` **reverts** for any agent with `raw < 50` — `(raw*conf)-(50*conf)` underflows in Solidity 0.8 | branched the calculation; added a 6-row worked-example table as the unit-test spec |
| 2 | `1284 completed / 49 failed` scores **96**, not the 94 printed everywhere | changed the example to `1284 / 81`, which really does score 94; fixed `successRate` 0.963 → 0.941 and volume 31.2 → 25.68 USDC |
| 3 | `fastPathMax = 0.50` would send the demo's 0.05 escrow job down the **direct** path — the demo could never show escrow | lowered to 0.03 and documented why the value looks arbitrary |
| 4 | `Outcome` enum used by `ReputationRegistry` but never defined | defined it |
| 5 | `Agent` struct wasted a storage slot (address cannot share an address's leftover 12 bytes) | reordered to pack; same for `Stats` |
| 6 | Caller authorisation for `TaskEscrow` never specified — anyone could create a job charged to another agent's wallet | added the full authorisation table |
| 7 | Fee rounding claimed to favour the protocol; the formula actually favours the worker | corrected the text to match the code |
| 8 | Demo panel said "4 txs"; the trace has 5 | fixed |

**Decided**
- Target **Track 4 — Trust, Identity & AI Infrastructure**
- D2 resolved: repos go public (submission requires a code link)

**Learned / changed**
- 🔴 `hackathon.monad.xyz` renders "MonadChain (ID: 143)" — **mainnet**. Every
  plan doc assumes testnet. This is now the highest-priority open question;
  it changes MockUSDC → real USDC and makes the spending caps load-bearing.
- Monad mainnet is live (v0.15.2). "Why Monad" framing should not read as if
  the chain were still pre-launch.

**Next**
- You: M0-03 repos · M0-04 wallets · **M0-02b testnet vs mainnet**
- Me: scaffolding, the moment repo URLs land

---

### Session 1 — 2026-09-22

**Did**
- Wrote the full specification: [01 idea](docs/01-idea.md), [02 flowcharts](docs/02-flowcharts.md),
  [03 tech stack](docs/03-tech-stack.md), [04 how it works](docs/04-how-it-works.md),
  [05 roadmap](docs/05-roadmap.md)
- Collected 4 decisions from you (repo split, key ownership, hosting, who codes)
- Wrote [06 repo structure](docs/06-repo-structure.md) — the 3-repo split and how ABIs cross boundaries
- Wrote [07 what I need from you](docs/07-what-i-need-from-you.md)
- Wrote [PLAN.md](PLAN.md) — 99 tasks across 7 milestones
- Wrote this file

**Decided**
- 3 repos · you hold keys · Vercel + Railway · Claude writes code · standard conventions

**Learned / changed**
- The 3-repo split costs ~half a day of setup and makes every ABI change a
  publish-bump-install cycle. Recorded in [06 §6](docs/06-repo-structure.md#6-what-changes-in-the-existing-docs)
  rather than discovered later.

**Next**
- You: M0-01 … M0-04
- Me: scaffolding, the moment repo URLs land

**Open questions**
- Deadline unconfirmed
- Monad chain facts unknown — every "verify against Monad docs" note in the
  specs is still open

---

## 🔄 How to update this file

At the **end of every session**, Claude updates, in this order:

1. `Last updated` + session number + days remaining
2. **Next actions** — both lanes, specific enough to act on cold
3. **Blockers** — add new, remove cleared, with dates
4. **Facts & Config** — anything that arrived this session
5. **Milestone board** — counts and status
6. **Current milestone table** — per-task status
7. **Decisions log** — append only, never rewrite
8. **Session log** — a new entry at the top

At the **start of every session**, Claude:

1. Reads this file first
2. Reads [PLAN.md](PLAN.md) for the current milestone's tasks
3. States the next task before starting it
4. Checks whether any 👤 item completed since last time

### Session log entry template

```markdown
### Session N — YYYY-MM-DD

**Did**
- [M#-##] what shipped

**Decided**
- decision + why

**Learned / changed**
- surprises, reversals, things the plan got wrong

**Next**
- You: …
- Me: …

**Open questions**
- …
```

### Rules

- **Never delete history.** Supersede, do not rewrite.
- A task is ✅ only when its definition of done in `PLAN.md` is met — not when
  the code is written.
- If a date slips, update the milestone board **and** say so in the session
  log. A silently slipped date is how a 21-day project becomes a 30-day one.
- If something is cut, mark it ❌ and record why. Cut work that is not written
  down gets half-rebuilt later.
