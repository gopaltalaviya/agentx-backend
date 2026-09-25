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
| Contract libs | **OpenZeppelin 5.x** | `ERC20`, `SafeERC20`, `AccessControl`, `ReentrancyGuard`, `Pausable`, `EIP712`. Do not hand-roll these. |
| Chain reads/writes | **viem 2.x** | Typed ABIs, lighter and stricter than ethers, first-class with TypeScript. |
| Backend | **TypeScript + Fastify** | Same language as the agents and the frontend; Fastify gives schema-validated routes and SSE without ceremony. |
| Database | **PostgreSQL 16** + **Drizzle ORM** | Relational job/ledger data with real constraints. Drizzle keeps migrations in SQL you can read. |
| Queue / cache | **Redis 7** + **BullMQ** | Job offers, retries, indexer cursor, rate limits, idempotency keys. |
| Indexer | Custom **viem `watchContractEvent`** worker | Contracts are few and events are few. A hosted indexer is more setup than it saves at this size. |
| Agent runtime | **TypeScript** + **Claude API** (`@anthropic-ai/sdk`) | The orchestrator and the worker agents are ordinary Node processes. |
| Agent interface | **MCP server** (`@modelcontextprotocol/sdk`) | Exposes `discover_agent`, `hire_agent`, `get_result` as tools, so any MCP-capable agent can transact. |
| Frontend | **Next.js 15** (App Router) + **React 19** | Marketplace, agent profile, live job feed. |
| Styling | **Tailwind CSS** + **shadcn/ui** | Demo-quality UI without a design phase. |
| Wallet UI | **wagmi 2** + **RainbowKit** | Human owner connects to register an agent and fund it. |
| Keys | **AWS KMS** in prod, encrypted keystore in dev | Agent keys never sit in plaintext on disk or in env vars in production. |
| Observability | **Pino** logs, **OpenTelemetry** traces | One trace ID spans user prompt → agent call → tx hash. |
| CI | **GitHub Actions** | `forge test`, `forge coverage`, `tsc --noEmit`, `vitest`, `eslint`. |
| Deploy | **Railway** or **Fly.io** (API + workers), **Vercel** (web) | Fastest path from commit to a public demo URL. |

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
└── docker-compose.yml       postgres + redis for local dev
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

**Gas.** Agents pay their own gas in MON. The signer service keeps every agent
wallet topped up from a funding wallet, and refuses to sign when balance is
below a floor rather than emitting a failing transaction.

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
can plug into". A judge can point their own agent at our MCP endpoint and hire
a bot. That is the strongest possible proof of the thesis.

**Separate signer service.** Key material lives in exactly one process, with
one job: check the spending policy, then sign. The API never touches a private
key. This is also what makes the on-chain `AgentAccount` policy credible —
defence in depth rather than a contract that trusts its caller.

---

## 5. Versions to pin

```
node            22 LTS
pnpm            9.x
solc            0.8.26
foundry         stable (record the exact nightly in CI)
openzeppelin    5.0.2
viem            2.x
fastify         5.x
next            15.x
react           19.x
drizzle-orm     0.33+
postgres        16
redis           7
```

Pin exact versions in the lockfile and in `foundry.toml`. A dependency that
moves under you the night before a deadline is a self-inflicted outage.

---

## 6. Local development

```bash
pnpm install
docker compose up -d                 # postgres + redis
pnpm --filter contracts test         # forge test -vvv
anvil --fork-url $RPC_URL            # local fork for fast iteration
pnpm --filter contracts deploy:local
pnpm db:migrate && pnpm db:seed      # 6 demo agents with history
pnpm dev                             # api + indexer + signer + web + agents
```

`pnpm db:seed` matters more than it looks: reputation is only interesting with
history behind it. The seed writes a few hundred settled jobs so the
marketplace does not open on a wall of zeroes during the demo.

---

## 7. Environment variables

**Secrets and wiring only.** Chain facts, protocol parameters and contract
addresses are versioned config, not env vars — see
[08 §5](08-configuration.md#5-environment-variables--secrets-and-wiring-only)
for the complete list and the reasoning.

```
ENABLED_CHAIN_IDS=10143       DEFAULT_CHAIN_ID=10143
RPC_URL_10143=                RPC_URL_143=          # optional overrides

DATABASE_URL=                 REDIS_URL=            API_JWT_SECRET=
SIGNER_KEYSTORE_JSON=         SIGNER_KEYSTORE_PASSPHRASE=
ANTHROPIC_API_KEY=            EXPLORER_API_KEY=
```

**No contract address is ever an env var.** That is the single most common
cause of "works locally, points at the wrong contract in production".

No private key ever appears in `.env` outside local development, and
`.env.example` ships with empty values only.
