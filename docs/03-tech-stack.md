# 03 — Technology Stack

Chosen for one constraint above all others: **a working end-to-end demo in
three weeks, by a small team.** Every pick below is boring on purpose. Novelty
belongs in the product, not in the toolchain.

---

## 1. At a glance

| Layer | Technology | Why this one |
|---|---|---|
| Chain | **Monad** (EVM) | Settlement layer. EVM equivalence means the whole Solidity/Foundry/viem toolchain works unchanged. |
| Contracts | **Solidity 0.8.26**, **Foundry** | Fast tests, fuzzing and invariants built in, no JS in the test loop. |
| Contract libs | **OpenZeppelin 5.0.2** | `SafeERC20`, `AccessControl`, `ReentrancyGuard`, `Pausable`, `Clones` (ERC-1167), `Initializable`. Do not hand-roll these. |
| Chain reads/writes | **viem 2.x** | Typed ABIs, lighter and stricter than ethers, first-class with TypeScript. |
| Backend | **TypeScript + Fastify 5** | Same language as the agents and the frontend. Fastify gives routes and SSE without ceremony. Request bodies are validated with **zod**. |
| Database | **PostgreSQL 16** + **Drizzle ORM** | Relational job/ledger data with real constraints. Drizzle keeps migrations in SQL you can read. |
| Queue / cache | **None, deliberately.** | Redis was planned and removed: nothing imported a client. Idempotency is a `UNIQUE` constraint in Postgres (`signer_txs` for transactions, `jobs.idempotency_key` per client for hires). The signer's nonce lock is a Postgres advisory lock. The indexer cursor is a table. Rate limiting is `@fastify/rate-limit`, in memory and per process, so N replicas allow N times the limit. Workers poll for jobs; there is no offer queue. |
| Indexer | Custom **viem `getLogs` polling** loop | Contracts are few and events are few. Polls in ranges capped by the chain's `maxLogRange` (Monad's RPC rejects `eth_getLogs` over 100 blocks), trailing the head by `confirmations`. A hosted indexer is more setup than it saves at this size. |
| Agent runtime | **TypeScript**, ordinary Node processes | A provider chain of **Claude**, **Gemini**, **Groq** and local **Ollama**, with automatic fallback along it, plus a recorded-replay backstop. `AGENT_MODE=cached` (the default) spends no tokens. The demo has run end to end on local Ollama, so no hosted key is required. |
| Agent interface | **MCP server** (`@modelcontextprotocol/sdk`, stdio) | Exposes `get_network`, `my_budget`, `discover_agents`, `hire_agent`, `get_job`, `await_result`, `approve_job`, `dispute_job` as tools, so any MCP-capable agent can transact. |
| Frontend | **Next.js 15** (App Router) + **React 19** | Marketplace, agent profile, registration, live run trace. |
| Styling | **Tailwind CSS 4** | Demo-quality UI without a design phase. No component library. |
| Wallet UI | **viem + EIP-1193** directly (injected wallets) | The owner connects on one page to send the ERC-8004 registration. wagmi + RainbowKit were dropped: RainbowKit needs a WalletConnect project id, and one page does not need shared reactive state. |
| Keys | **Encrypted keystore** (Web3 Secret Storage) in an env var, passphrase in a second one | Decision C1. A raw dev key is allowed on testnet only. AWS KMS is not built; the `KeySource` interface is where it would slot in. |
| Observability | **Pino** logs, `x-trace-id` on every response | The request id is stored on the job row (`trace_id`). There is no OpenTelemetry. |
| CI | **GitHub Actions**, one workflow per repo | contracts: `forge fmt --check`, `build`, `test`, `coverage`, `snapshot --check`, config and secrets checks, `verify-erc8004`. backend: `tsc -b`, secrets check, migrations and `vitest` against a real Postgres. interface: `tsc --noEmit`, `vitest`, `next build`. There is no eslint. |
| Deploy | **Railway** (API, signer, indexer, Postgres), **Vercel** (interface) | Chosen, not yet provisioned (blocked on accounts). |

---

## 2. Repository layout

> ⚠️ **Superseded 2026-09-22 by [06 — Repository Structure](06-repo-structure.md).**
> The project uses **three separate repositories** so that contracts never
> enter a Vercel or Railway build container. The technology choices in this
> document are unchanged; only the layout differs. The single-monorepo layout
> below is kept for reference on how the pieces relate.

A pnpm monorepo. One install, one typecheck, shared types between contracts,
backend, agents and web.

```
agentx/
├── contracts/               Foundry project
│   ├── src/
│   │   ├── StakeVault.sol
│   │   ├── TaskEscrow.sol
│   │   ├── fallback/            # only if ERC-8004 verification fails
│   │   ├── AgentAccount.sol
│   │   ├── AgentAccountFactory.sol
│   │   └── mocks/MockUSDC.sol
│   ├── test/                unit · fuzz · invariant
│   ├── script/Deploy.s.sol
│   └── foundry.toml
│
├── packages/
│   ├── contracts-types/     generated ABIs + viem typed clients
│   ├── sdk/                 @agentx/sdk — the client any agent imports
│   └── shared/              zod schemas, job spec types, error codes
│
├── apps/
│   ├── api/                 Fastify: REST + SSE + auth
│   ├── indexer/             chain events → Postgres
│   ├── signer/              policy-checked transaction signing
│   ├── mcp/                 MCP server for agent-facing tools
│   ├── agents/
│   │   ├── orchestrator/    the "main agent"
│   │   ├── research-bot/
│   │   ├── trading-bot/
│   │   └── execution-bot/
│   └── web/                 Next.js marketplace + live demo view
│
├── docs/                    these files
└── docker-compose.yml       postgres for local dev
```

---

## 3. Chain configuration

Verified 2026-09-22 against the official Monad documentation and Chainlist.
Re-check before deploying — a chain config is worth confirming with your own
eyes.

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | **10143** | **143** |
| RPC | `https://testnet-rpc.monad.xyz` | `https://rpc.monad.xyz` (+ `rpc1`–`rpc3`) |
| Explorer | `https://testnet.monadexplorer.com` | `https://monadvision.com`, `https://monadscan.com` |
| Faucet | `https://faucet.monad.xyz` | — |
| Currency | MON (18 decimals) | MON (18 decimals) |

**Decision (2026-09-22): testnet first, both supported by the same code.**
The network is configuration, never a code path — there is no
`if (isMainnet)` anywhere in the application.

```ts
import { loadConfig } from '@agentx/config'

const config = loadConfig()                   // validated + frozen at boot
const chain  = config.chains[chainId]         // never "the" chain
```

The chain registry, the per-network protocol parameters, the generated
deployment addresses and the env split are all specified in
**[08 — Configuration Architecture](08-configuration.md)**. Do not define a
chain object anywhere else; `config.chains[id].viemChain` is the only one.

**Payment token.** The protocol takes the ERC-20 address as a deploy
parameter; it is not hard-coded to any one stablecoin. On testnet we deploy
`MockUSDC` (6 decimals, public `mint`) so demos are not faucet-limited. If a
canonical bridged USDC exists on the target network, point the same parameter
at it — no code change.

**ERC-8004.** Deployed on mainnet, absent on testnet (verified 2026-09-22).
`Deploy.s.sol` deploys our own minimal registries on a testnet, and refuses to
on a non-testnet. On mainnet it adopts the canonical `0x8004…` addresses from
`config/networks.json`.

**Gas.** Agents pay their own gas in MON. The signer refuses to sign when the
agent's balance is below a floor (0.01 MON) rather than emitting a failing
transaction, and names the address to fund. **It does not top wallets up.**
Wallets are funded by hand from `DEPLOYER`/`FUNDER` (the faucet has
bot-detection and cannot be scripted).

---

## 4. Why these choices, where it actually matters

**Foundry over Hardhat.** The escrow is a state machine holding other people's
money. Foundry's invariant testing lets us assert the property that matters —
*contract token balance always equals the sum of locked job amounts* — against
randomised call sequences. That is worth more than any number of hand-written
unit tests.

**viem over ethers.** ABIs are typed from the Foundry artifacts, so a changed
function signature is a compile error in the backend, not a runtime revert
during the demo.

**Postgres, not "everything on-chain".** On-chain state is the minimum needed
for trustlessness: who owns what, how much is locked, what the outcome was, the
result hash. Job descriptions, result payloads, search indexes and analytics
live in Postgres, which is cheaper, queryable and mutable. The chain is the
ledger; the database is the cache and the catalogue.

**MCP as the agent interface.** Exposing hire/discover/settle as MCP tools is
the difference between "a dApp with an AI theme" and "infrastructure any agent
can plug into". The server is a **stdio** process (`apps/mcp`). A judge runs it
locally with `AGENTX_API_URL` and an agent's `AGENTX_API_KEY`, points their
own agent at it, and hires a bot. That is the strongest possible proof of the
thesis.

**Separate signer service.** Key material lives in exactly one process, with
one job: check the spending policy, then sign. The API never touches a private
key. It encodes the call and sends it to the signer's `POST /sign`. The design
pairs this with the on-chain `AgentAccount` policy for defence in depth.

As built (2026-09-29):

- **Caller authentication** is a shared secret, `SIGNER_TOKEN`, which the API
  presents as a bearer token and the signer compares in constant time.
  Without a token configured, the signer binds to `127.0.0.1` only and
  refuses a wider `SIGNER_HOST`.
- **Caps.** Where the wallet is an `AgentAccount` — in the demo, the
  orchestrator's, the only agent that spends — the signer reads the caps from
  the contract to refuse early with a clear error, then sends the call to the
  account as `execute(target, data)`, signed by a live session key (the
  owner's key as fallback). The contract enforces the caps and allowlist;
  the signer keeps no off-chain reservation for it. The three workers use
  plain EOAs, so for them the signer enforces the agent's `spend_policies`
  row itself: it checks and reserves the spend in one `UPDATE` under the
  per-agent lock (rolling 24-hour window) and refuses an agent with no
  policy. That is enforcement outside the model, but not on-chain. See
  [04 §3.2](04-how-it-works.md#32-signer-service).
- The signer process also runs the **keeper** (`KEEPER_PRIVATE_KEY`, its own
  key), which sends the escrow's permissionless exits when they fall due.

---

## 5. Versions to pin

```
node            >= 22 (engines)
pnpm            9.12.0 (packageManager)
solc            0.8.26, via_ir = true (required: ERC-8004's 11-argument
                NewFeedback event overflows the stack without it)
foundry         stable (CI prints `forge --version`)
openzeppelin    5.0.2
viem            2.x
fastify         5.x
next            15.5.x
react           19.x
tailwindcss     4.x
drizzle-orm     0.36
postgres        16 (postgres:16-alpine in docker-compose)
```

Pin exact versions in the lockfile and in `foundry.toml`. A dependency that
moves under you the night before a deadline is a self-inflicted outage.

---

## 6. Local development

```bash
# contracts (separate repo)
cd agentx-contracts
make test                            # forge test -vvv
anvil                                # local chain, in another terminal
make deploy-local                    # writes deployments/31337.json

# backend
cd ../agentx-backend
pnpm install
docker compose up -d                 # postgres only, on host port 5442
pnpm -r build                        # services and scripts run from dist/
pnpm db:migrate
pnpm --filter @agentx/api start      # likewise signer, indexer, apps/agents/*

# the whole loop, unattended
pnpm e2e                             # scripted hire → settle
pnpm demo                            # orchestrator + three workers
```

There is no `pnpm dev` that starts the stack. The root `dev` script runs each
package's `dev` script, and only the indexer has one (`tsc --watch`). Each
service starts from its own `start` script, and `pnpm demo` boots what it
needs itself.

There is no seed of historical jobs. `pnpm db:seed` was removed on Sep 29: it
pointed at a `packages/db/bin/seed.mjs` that never existed. Demo agents are
registered fresh by `scripts/demo.mjs` and start at the unproven score of 50.

---

## 7. Environment variables

**Secrets and wiring only.** Chain facts, protocol parameters and contract
addresses are versioned config, not env vars — see
[08 §5](08-configuration.md#5-environment-variables--secrets-and-wiring-only)
for the complete list and the reasoning.

```
# agentx-backend/.env
ENABLED_CHAIN_IDS=10143       DEFAULT_CHAIN_ID=10143
AGENTX_CONTRACTS_ROOT=../agentx-contracts
RPC_URL_10143=                RPC_URL_143=          # optional overrides

DATABASE_URL=                 SIGNER_URL=
SIGNER_TOKEN=                 SIGNER_HOST=          # API ↔ signer secret; bind address
SIGNER_KEYSTORE_JSON=         SIGNER_KEYSTORE_PASSPHRASE=
SIGNER_DEV_PRIVATE_KEY=                             # testnet only
KEEPER_PRIVATE_KEY=           KEEPER_INTERVAL_MS=15000   # keeper; testnet only as a raw key

AGENT_MODE=cached             BRAIN_CHAIN=          BRAIN_CHAIN_ORCHESTRATOR=
OLLAMA_HOST=                  OLLAMA_MODEL=         # local, no key needed
GEMINI_API_KEY=               GROQ_API_KEY=         ANTHROPIC_API_KEY=   # all optional
AGENTX_API_URL=               AGENTX_API_KEY=       AGENTX_CHAIN_ID=     # agent processes

# agentx-contracts/.env
EXPLORER_API_KEY=                                   # source verification only
```

`.env.example` in each repo is the complete, commented list.

There is no `REDIS_URL` (nothing uses Redis) and no `API_JWT_SECRET`.
Authentication is a per-agent API key (`Authorization: Bearer ax_…`), stored
only as a salted scrypt hash.

**No contract address is ever an env var.** That is the single most common
cause of "works locally, points at the wrong contract in production".

No private key ever appears in `.env` outside local development, and
`.env.example` ships with empty values only.
