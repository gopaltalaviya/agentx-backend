# 06 — Repository Structure (3 repos)

**Decision (2026-09-22):** three separate repositories. Contracts are never
part of a Vercel or Railway build.

```
agentx-contracts     Foundry only.        Deployed by:  you, manually
agentx-backend       pnpm monorepo.       Deployed by:  Railway
agentx-interface     Next.js only.        Deployed by:  Vercel
```

Why it is split this way: a Vercel or Railway build pulls the whole repo into
a build container. If contracts live in that tree, your Foundry sources,
deploy scripts and any key material in `.env` go with it. Separate repos make
that structurally impossible rather than a configuration setting somebody
might get wrong.

---

## 1. `agentx-contracts`

Private. Never connected to Vercel or Railway. No hosting provider has read
access.

```
agentx-contracts/
├── src/
│   ├── TaskEscrow.sol           # job state machine + settlement + feedback
│   ├── StakeVault.sol           # bonds per ERC-8004 agentId
│   ├── AgentAccount.sol         # on-chain spending policy
│   ├── AgentAccountFactory.sol
│   ├── interfaces/
│   │   ├── IIdentityRegistry.sol    # ERC-8004, external
│   │   ├── IReputationRegistry.sol  # ERC-8004, external
│   │   ├── ITaskEscrow.sol
│   │   └── IStakeVault.sol
│   ├── fallback/                # built ONLY if M1-00 verification fails
│   │   ├── AgentRegistry.sol
│   │   └── ReputationRegistry.sol
│   └── mocks/MockUSDC.sol
├── test/
│   ├── unit/
│   ├── fuzz/
│   └── invariant/
├── script/
│   ├── Deploy.s.sol
│   └── SeedDemo.s.sol
├── config/                   # SINGLE SOURCE — see docs/08
│   ├── networks.json         # chain registry, keyed by chainId
│   ├── params.10143.json     # protocol parameters, testnet
│   ├── params.143.json       # protocol parameters, mainnet
│   └── params.31337.json     # local anvil
├── deployments/              # GENERATED — never hand-edited
│   ├── 10143.json            # addresses + startBlock + commit
│   ├── 143.json
│   └── 31337.json
├── export/                   # generated, published to npm
│   ├── abis/*.json
│   └── index.ts
├── .env.example              # never .env
├── foundry.toml
├── remappings.txt
├── Makefile
└── .github/workflows/ci.yml
```

**`Makefile`** — the entire interface you need:

```makefile
NETWORK ?= monad_testnet          # alias from foundry.toml [rpc_endpoints]

build:            forge build
test:             forge test -vvv
coverage:         forge coverage --report summary
snapshot:         forge snapshot
export:           node scripts/export-abis.mjs       # src + config → export/
drift:            node scripts/check-param-drift.mjs # deployed values vs config

deploy:           ## NETWORK=monad_testnet make deploy
	forge script script/Deploy.s.sol --rpc-url $(NETWORK) --broadcast --verify
	node scripts/write-deployment.mjs $(NETWORK)

deploy-local:     NETWORK=anvil  $(MAKE) deploy
deploy-testnet:   NETWORK=monad_testnet $(MAKE) deploy
deploy-mainnet:   ## requires typing the chain id to confirm
	@echo "MAINNET deploy. Type the chain id to confirm:"; read -r c; \
	 [ "$$c" = "143" ] || { echo aborted; exit 1; }
	NETWORK=monad $(MAKE) deploy

publish:          npm version patch && npm publish
```

You only ever run `make deploy-testnet` and `make publish`. I write everything
they call. There is one `deploy` target, parameterised by network — not one
target per network that drifts apart.

---

## 2. `agentx-backend`

pnpm monorepo. Deploys to Railway. Contains Postgres migrations, Redis usage,
and all long-running processes.

```
agentx-backend/
├── apps/
│   ├── api/          Fastify REST + SSE
│   ├── indexer/      chain events → Postgres
│   ├── signer/       policy check + KMS sign + broadcast
│   ├── mcp/          MCP server (agent-facing tools)
│   └── agents/
│       ├── orchestrator/
│       ├── research-bot/
│       ├── trading-bot/
│       └── execution-bot/
├── packages/
│   ├── config/       THE import for chain facts, params, addresses
│   ├── shared/       zod schemas, JobSpec/JobResult, error codes, validateShape
│   ├── db/           Drizzle schema + migrations
│   ├── sdk/          the typed client every agent uses
│   └── agent-core/   brains, prompts, judge, worker loop, orchestrator
├── docs/             00..10 — the specification (moved here 2026-09-25)
├── PLAN.md           the task plan
├── PROGRESS.md       the running build log
├── scripts/          e2e, demo, verify-indexer, check-no-secrets
├── docker-compose.yml        # local postgres :5442 + redis :6381
├── pnpm-workspace.yaml
├── .env.example
└── .github/workflows/ci.yml
```

> **The specification lives here**, not beside the repos. Until 2026-09-25 the
> docs, the plan and the build log were in no repository at all — the code was
> on GitHub, the thinking behind it was on one machine in a folder named
> `temp`. No fourth repo was created; they went into the largest existing one.

Each app is a separate Railway service off the same repo, with its own start
command:

| Railway service | Start command | Notes |
|---|---|---|
| `api` | `pnpm --filter @agentx/api start` | public, has a domain |
| `indexer` | `pnpm --filter @agentx/indexer start` | no public port |
| `signer` | `pnpm --filter @agentx/signer start` | **private networking only** |
| `agents` | one service per bot, e.g. `pnpm --filter @agentx/research-bot start` | no public port |
| Postgres | Railway plugin | |
| Redis | Railway plugin | |

Filters take the **package name**, not the directory — `--filter api` matches
nothing.

`mcp` is **not** a Railway service: it speaks MCP over stdio, so a client
spawns it rather than calling it over HTTP. Hosting it would mean building a
transport it does not have.

`railway.json` does not exist yet; Railway deployment is M5 work and is not
started.

`signer` must not be exposed publicly. Railway private networking only; the
API reaches it at its internal hostname.

---

## 3. `agentx-interface`

Next.js 15. Deploys to Vercel. Read-only against the API — it never signs a
protocol transaction and never holds a key beyond the visitor's own wallet
connection.

```
agentx-interface/
├── app/
│   ├── page.tsx                  marketplace
│   ├── agents/[id]/page.tsx      agent profile
│   ├── demo/page.tsx             live demo view
│   └── register/page.tsx         register an agent (wagmi)
├── components/
├── lib/
│   ├── api.ts                    typed client for agentx-backend
│   └── wagmi.ts
├── .env.example
├── vercel.json
└── .github/workflows/ci.yml
```

---

## 4. How code crosses repo boundaries

Standard approach: **publish npm packages to GitHub Packages**, private scope,
semver. No git submodules, no copy-paste, no `file:` links.

```
agentx-contracts ──publishes──▶ @agentx/contracts   ABIs + networks + deployments
                                       │
                                       ▼
                                @agentx/config      validated, frozen, one import
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 ▼                                           ▼
        agentx-backend ──publishes──▶ @agentx/shared ──▶ agentx-interface
                                      (JobSpec, JobResult,
                                       error codes, API types)
                        └──publishes──▶ @agentx/sdk  ──▶ agents, interface
```

Dependency direction is strictly one-way: `contracts → config → shared → sdk`.
Nothing can form a cycle.

### `@agentx/contracts`

Generated by `make export`. Contains no Solidity — only what consumers need,
keyed by chain ID so nothing is ever "the" network:

```ts
export { agentRegistryAbi, taskEscrowAbi, reputationRegistryAbi, agentAccountAbi }
export { networks }        // config/networks.json, typed
export { deployments }     // deployments/*.json, keyed by chainId

export function getDeployment(chainId: number): Deployment  // throws if unknown
```

`deployments[chainId].startBlock` is why the indexer never scans from genesis.
Full design: [08 — Configuration Architecture](08-configuration.md).

### `@agentx/shared`

Zod schemas and the types derived from them. One definition of `JobSpec`, used
by the API for validation, by agents for construction, and by the interface for
display.

### Release rules

- Semver. ABI change → **minor** before launch, **major** after.
- The ABI freezes 2026-09-28 ([roadmap M1](05-roadmap.md#4-m1--contracts--sep-2528)).
  After that, a change requires a written reason and a version bump across all
  three repos.
- Consumers pin exact versions. No `^` ranges on a 21-day clock.

### The escape hatch

Publishing to GitHub Packages needs a token and about twenty minutes of setup.
If that blocks on day one, the fallback is: `agentx-contracts` commits
`export/` and both consumers install it as a git dependency
(`github:you/agentx-contracts#v0.1.0`). Same versioning, zero registry setup.
Decide this on **Sep 23**, not later.

---

## 5. Standard conventions (all three repos)

Nothing bespoke. If a tool has a documented default, we use it.

| Area | Convention |
|---|---|
| Branching | **`main` only, direct commits.** The branch-and-PR convention below was written for a team; with one person and an assistant it added ceremony and no review, so it was dropped rather than pretended at. |
| Commits | [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `chore:`, `docs:`, `test:` |
| Versioning | Semver, tagged `v0.1.0` |
| TS config | `strict: true`, `noUncheckedIndexedAccess: true` |
| Lint / format | Prettier defaults. **No ESLint** — the `lint` script was declared but no config or dependency ever existed, so it failed on every invocation. Removed rather than left as a script that lies. TypeScript strict, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` carry the weight. |
| Solidity style | [Official Solidity style guide](https://docs.soliditylang.org/en/latest/style-guide.html), `forge fmt` |
| NatSpec | Every external function on every contract |
| Env | `.env.example` committed with empty values; `.env` gitignored everywhere |
| CI | contracts: fmt, build, test, coverage, gas snapshot. backend: typecheck + secret scan always; the suite needs a Postgres service **and** the contracts checkout, so it skips rather than fails while that repo is private. interface: typecheck + build. |
| PRs | **Not used.** 27 commits straight to `main`. The commit messages carry the reasoning a PR description would. |
| Changelog | **None.** No repo has one. `PROGRESS.md` is the real change log, and two logs disagree the moment one is forgotten. |

---

## 6. What changes in the existing docs

[03-tech-stack §2](03-tech-stack.md#2-repository-layout) describes a single
monorepo. **This document supersedes it.** The technology choices in 03 are
unchanged; only the layout differs.

The milestones in [05-roadmap](05-roadmap.md) are unchanged — M1 is
`agentx-contracts`, M2 is `agentx-backend`, M4 is `agentx-interface`. The split
adds one task to M0: publish `@agentx/contracts` v0.0.1 and install it in both
consumers, so the wiring is proven before there is anything real to wire.

**Cost of the split, stated honestly:** roughly half a day of extra setup, and
every ABI change becomes publish → bump → install in two places instead of a
single save. That is the price of contracts never entering a hosting provider's
build container, and on this project it is worth paying.
