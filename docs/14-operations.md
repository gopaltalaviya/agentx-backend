# 14 — Operations

How AGENTX runs in production: what each service exposes about its health,
how versions and environments work, what is monitored and what should alert,
how the indexer and database behave when things go wrong, and what to do in
an incident. Step-by-step procedures are in [16 — Runbooks](16-runbooks.md);
the verified checklist is [17 — Production readiness](17-production-readiness.md).
Deploying for the first time is [13 — Deploy](13-deploy.md); every variable is
in [08 §5](08-configuration.md#5-environment-variables--secrets-and-wiring-only);
the HTTP API is [15 — API](15-api.md).

Written 2026-09-30 from the code at the commit that adds it. Nothing here
describes a hosted deployment — none exists yet (blocker B8 in PROGRESS.md).

**Not applicable to AGENTX**, so not covered: Redis or any cache/queue (none —
see `docker-compose.yml`), WebSockets (live updates are SSE), a subgraph (the
indexer is our own), trading, markets or price charts.

---

## 1. Architecture and data flow

```
Monad testnet ──logs──▶ indexer ──▶ Postgres ◀── api ──HTTPS/SSE──▶ interface (Vercel) ──▶ browser
      ▲                                ▲          │
      └──────── signed txs ─── signer ─┘◀─token───┘     workers / orchestrator ──▶ api
                     └─ keeper (exits that fell due)
```

| Service | Code | Role | Listens | Public? |
|---|---|---|---|---|
| api | `apps/api` | REST + SSE, runs the orchestrator in-process | `PORT` 8080 | **yes** — the only public service |
| signer | `apps/signer` | holds agent keys, policy-checks and signs; keeper sweeps due exits | `SIGNER_PORT` 7070 | **never** — private network + `SIGNER_TOKEN` |
| indexer | `apps/indexer` | polls `TaskEscrow` logs → `job_events`, projections | `INDEXER_HEALTH_PORT` (optional) | no |
| workers | `apps/agents/*` | research/trading/execution bots, poll the API | — (x402 port optional) | no |
| mcp | `apps/mcp` | stdio MCP server for an LLM client | stdio | not deployed |
| Postgres 16 | `packages/db` | all state; migrations in `packages/db/migrations` | 5432 | no |

A hire: client → `POST /v1/jobs` → API writes the job, asks the signer →
signer checks caps, takes a per-agent advisory lock, picks the nonce, signs,
broadcasts → API answers with `txHash` and publishes `job.created` on SSE →
the indexer, trailing the head by `confirmations`, sees `JobCreated`, links the
row to its on-chain id by `specHash` + both parties, and projects state,
payments and reputation → the interface reads them from the API.

### Where each workload belongs

| Workload | Fits | Does not fit | Why |
|---|---|---|---|
| api | Railway service (or any long-running container host) | Vercel functions | SSE streams stay open for minutes; an in-process run lasts longer than any function timeout |
| signer | Railway service on the **private network only** | anything with a public URL; serverless | it holds keys; `bindHost` refuses a non-loopback bind without `SIGNER_TOKEN` |
| indexer | Railway service, one replica | serverless / cron | a long-running poller with backoff; two replicas would do the same work twice (safe, since writes are idempotent, but wasteful) |
| Postgres | Railway managed Postgres | a container without a volume | state; backups are a platform feature ([§8](#8-backup-and-disaster-recovery)) |
| interface | Vercel | — | static + SSR Next.js; `NEXT_PUBLIC_API_URL` is baked in at build |
| Hetzner / a VM | all backend services via `docker-compose.full.yml` | — | viable and cheaper, but you then own TLS, restarts, backups and patching. Not needed for the hackathon |

## 2. Health, readiness and status

Every field is classified: **public** (safe on the internet), **authenticated**
(needs a token), **internal** (reachable only on the private network).

| Endpoint | Service | Returns | Class |
|---|---|---|---|
| `GET /health` | api | `ok`, `chains[{chainId,name,testnet,escrow}]`, `defaultChainId`, `subscribers` (open SSE subscriptions), `orchestrator`, `build` | public |
| `GET /ready` | api | 200/503, `checks.database.ok`, `checks.signer.ok` — **no error text** since 2026-09-30 (it used to echo the driver error, which names internal hosts) | public |
| `GET /v1/status` | api | overall status, components, per-chain RPC + indexer lag, build — [15 §4](15-api.md#4-get-v1status) | public |
| `GET /metrics` | api | Prometheus text | authenticated (`METRICS_TOKEN`); **not served** in production without one |
| `GET /health` | signer | `ok`, `chainId`, `keys` (`raw`/`keystore` kind, never a key), `build` | internal |
| `GET /ready` | signer | `checks.database`, `checks.rpc`, with error text | internal |
| `GET /metrics` | signer | Prometheus | internal (+ `METRICS_TOKEN` if set) |
| `GET /health` | indexer | `ok`, `build` | internal |
| `GET /ready` | indexer | `checks.database`, `checks.chain-<id>`: failing when no successful tick within `INDEXER_MAX_BACKOFF_MS + 5×INDEXER_POLL_MS` (70 s by default) | internal |
| `GET /metrics` | indexer | Prometheus | internal |

Railway health checks (`deploy/railway/*.json`): api → `/ready` (so an API
whose signer is down fails its deploy — deploy the signer first), signer →
`/ready`, indexer → `/health`, workers → none.

`/v1/status` is the endpoint for a public status page and for an external
uptime monitor. It is cached 5 s, bounded at 2 s per check, always answers
200, and was checked against Monad testnet on 2026-09-30 (a real head block,
the dev database's cursor, and a signer that was not running — reported
`signer: "down"`, `status: "degraded"`, nothing else).

## 3. Versioning

One scheme, one source per kind of version:

| What | Version | Where it is recorded | Rule |
|---|---|---|---|
| **A running backend** | the **git commit** | `/app/build-info.json` in the image → `build.commit` on every `/health` and `/v1/status` | The commit is the release identity. Nothing else needs to be bumped to deploy |
| HTTP API | `/v1` path prefix | `apps/api/src/routes/*` | Additive changes (new fields, routes, optional params) stay in `/v1`. Removing or changing the meaning of a field is a new prefix served alongside the old |
| Database schema | ordered migration files | `packages/db/migrations`, ledger table `_migrations` | Forward-only; never rename or edit an applied file ([§7](#7-database-and-migrations)) |
| Contracts | deployment | `deployments/<chainId>.json` → `commit`, `deployedAt`, `startBlock`; copied to `chain/` | A redeploy is new addresses and a new `startBlock`; `chain/` must be re-synced (CI fails otherwise) |
| Packages | `package.json` `version` | `0.0.1` in every backend package; `0.1.0` interface and contracts | Private and unpublished, so they carry no meaning today. `build.version` reports them for completeness |

How the commit gets into the image: the Dockerfile's runtime stage takes
`ARG GIT_SHA`, defaulting to `RAILWAY_GIT_COMMIT_SHA` (which Railway passes to
Dockerfile builds triggered from GitHub, when declared as an `ARG`), and writes
it with the build time. CI passes `github.sha` and asserts it. A local
`docker build` without `--build-arg GIT_SHA=$(git rev-parse HEAD)` reports
`"commit": "unknown"` — honest, not wrong. Outside an image, `GIT_SHA` in the
environment is used if it is a hex commit. Anything that is not a hex commit,
a semver or an ISO time is reported as unknown, never echoed.

Proposed release tags when there is something to release to someone:
`backend-v0.x.y` on the commit that was deployed. Not created — no tags exist
and nothing consumes them yet (owner decision, [17](17-production-readiness.md)).

## 4. Environments and configuration

| Environment | Chain | Database | How it runs | Config |
|---|---|---|---|---|
| **local dev** | anvil 31337 or Monad testnet 10143 | docker compose Postgres on `127.0.0.1:5442` (shared; the test suite TRUNCATEs it) | `pnpm dev`, scripts | `.env` (from `.env.example`) + `agentx-contracts` checkout |
| **local production images** | 10143 | its own Postgres on `:5443`, own volume | `docker-compose.full.yml` | shell env; chain facts from `chain/` |
| **CI** | none (unit + integration against Postgres) | service container `:5442` | `.github/workflows/ci.yml` | contracts repo checked out beside |
| **testnet hosted** (planned) | 10143 | Railway Postgres | Railway + Vercel, [13](13-deploy.md) | Railway variables; chain facts from `chain/` in the image |
| **mainnet** (future) | 143 | separate | not built | `deployments/143.json` does not exist, so `ENABLED_CHAIN_IDS=143` refuses to boot. The signer refuses raw keys and the keeper refuses to start off-testnet |

**Which copy of a fact is authoritative** — the rule from docs/08, checked
across the three repos on 2026-09-30:

| Fact | Authoritative | Copies, and what keeps them honest |
|---|---|---|
| Network facts (chain id, RPC, explorer, confirmations) | `agentx-contracts/config/networks.json` | `agentx-backend/chain/config/` — byte copy, `sync-chain-facts.mjs --check` in CI. The interface reads them at runtime from `GET /v1/network` |
| Protocol parameters | `agentx-contracts/config/params.<id>.json` | `chain/config/`, same check; on-chain values checked by `make drift` in the contracts repo (manual) |
| Contract addresses | `agentx-contracts/deployments/<id>.json` (generated) | `chain/deployments/` (same check); served by `/health` and `/v1/network`; `check-deployment.mjs` compares the live API with `chain/` |
| RPC override | `RPC_URL_<chainId>` env, per service (api, signer, indexer) | must be set on each service that reads chain state; never served (`/v1/network` publishes the public URLs only) |
| API URL | `NEXT_PUBLIC_API_URL` on Vercel (build time) | `CORS_ORIGINS` on the API must name the site; `AGENTX_API_URL` for workers |
| Secrets | `.env` / Railway variables | none — `.env.example` has names only |

Deliberate duplicates in the interface, both security allowlists with an env
override rather than config drift: the CSP's RPC origins
(`next.config.mjs`, `NEXT_PUBLIC_RPC_ORIGINS`) and the explorer host allowlist
for links (`lib/links.ts`, `NEXT_PUBLIC_EXPLORER_HOSTS`). Test fixtures and the
mock API (`e2e/mock-api.mjs`) hard-code testnet addresses on purpose. Nothing
was consolidated: every copy is either checked or intentional.

The variable list in docs/08 §5 was re-checked against every service's env
schema on 2026-09-30 and brought up to date (it was missing 17 names).

## 5. Monitoring and alerting

### What exists

- **Logs:** pino, JSON to stdout, one `service` field per process, with
  redaction of `authorization`, `x-payment`, `cookie`, and any `apiKey`,
  `privateKey`, `password`, `passphrase`, `token` field
  (`packages/service/src/http.ts`). The API logs every request; the signer and
  indexer log events and failures. Railway keeps stdout as the service log.
- **Request ids:** an incoming `x-request-id` is honoured, else a UUID; the API
  returns it as `x-trace-id` and in every problem body, and forwards it to the
  signer.
- **Metrics** (`prom-client`, one registry per service, label `service`):

| Metric | Service | Labels |
|---|---|---|
| Node defaults (`process_cpu_*`, `process_resident_memory_bytes`, `nodejs_eventloop_lag_*`, `nodejs_heap_*`, `nodejs_gc_duration_seconds`, …) | all | — |
| `http_request_duration_seconds` (histogram) | api, signer, indexer health port | `method`, `route` (template), `status` |
| `signer_signed_total` | signer | `replayed` |
| `signer_refusals_total` | signer | `code` |
| `keeper_exits_total` | signer (keeper) | `exit`, `outcome` |
| `indexer_ticks_total` | indexer | `chain`, `outcome` |
| `indexer_last_success_seconds` | indexer | `chain` |
| `indexer_head_block`, `indexer_indexed_block`, `indexer_lag_blocks` | indexer (added 2026-09-30) | `chain` |

- **Escalating logs:** the indexer logs `warn` per failed tick and `error`
  ("indexer is failing") from the fifth consecutive failure.

### What is missing

No alerting, no error tracking (Sentry or similar), no dashboards, no metrics
scraper. Railway does not scrape Prometheus endpoints; `/metrics` is only useful
once something collects it.

### What to wire up, smallest first

1. **An external uptime monitor** (any HTTP checker) on the API's
   `GET /v1/status` every 1–5 min, alerting when `status != "operational"`
   (body match), and on `GET /ready` for HTTP 503. This covers the database,
   signer, RPC and indexer lag with no new infrastructure.
2. **Railway's own deploy/crash notifications** for every service (project
   settings).
3. Later: a Prometheus-compatible scraper (e.g. Grafana Cloud agent) with
   `METRICS_TOKEN`, for the alerts below that need metrics.

### Alerts

| Condition | Source | Severity | Owner | Runbook |
|---|---|---|---|---|
| `/v1/status` → `status: "down"` or unreachable for 2 checks | uptime monitor | SEV1 | owner | [R2](16-runbooks.md#r2-database-down), [R6](16-runbooks.md#r6-recover-a-failed-service) |
| `components.signer == "down"` 5 min | uptime monitor | SEV2 — hires and transitions fail with 503 | owner | [R6](16-runbooks.md#r6-recover-a-failed-service) |
| `components.indexer == "degraded"` 15 min (lag > 150 + confirmations), or `"down"` 5 min (stopped) | uptime monitor / `indexer_lag_blocks` | SEV3 (SEV2 if down) — settlements show late | owner | [R3](16-runbooks.md#r3-indexer-stopped-or-behind) |
| indexer `/ready` 503, or log "reorg dropped … halting" | Railway health / logs | SEV2 — projection frozen | owner | [R4](16-runbooks.md#r4-indexer-halted-on-a-reorg-or-showing-wrong-data) |
| `components.rpc == "down"` 10 min | uptime monitor | SEV2 | owner | [R5](16-runbooks.md#r5-rpc-down-or-rate-limited) |
| `rate(signer_refusals_total{code="INTERNAL"}[10m]) > 0` | metrics | SEV3 | owner | [R6](16-runbooks.md#r6-recover-a-failed-service) |
| `rate(http_request_duration_seconds_count{status=~"5.."}[5m])` > 1% of requests | metrics | SEV3 | owner | read logs by `traceId` |
| `keeper_exits_total{outcome="failed"}` increasing | metrics | SEV3 — expired jobs not exited; check keeper MON balance | owner | [R9](16-runbooks.md#r9-rotate-secrets-and-keys) |
| Agent / keeper wallet MON low | **not monitored** — check before a demo | SEV3 | owner | fund from DEPLOYER |

The owner is the project owner for every row: there is one person on call.

## 6. Indexer lifecycle

- **Cursor:** `indexer_cursor (chain_id, contract)` → `last_block`,
  `last_block_hash`, `updated_at`. A first start with no cursor begins at the
  deployment's `startBlock` and backfills (Monad testnet caps `eth_getLogs` at
  `maxLogRange` = 100 blocks per call, so a long backfill takes hours).
  `seedCursorToHead()` exists for a first start that does not need history —
  used by the demo, not by `main.ts`.
- **Each tick:** read head → safe head = head − `confirmations` → check the
  cursor block's hash still matches (reorg check) → `getLogs` for at most
  `maxLogRange` blocks → apply each log in one transaction → write the cursor.
  A tick with no new safe blocks writes nothing (so `updated_at` stands still
  on an idle local chain).
- **Idempotent replay:** each log is inserted into `job_events` under
  `UNIQUE (chain_id, tx_hash, log_index)` plus a same-tx/same-kind check, and
  its effects (state, `payments`, reputation) run only if that insert
  happened. Replaying any range is a no-op — re-verified live on 2026-09-30.
- **Forward-only state:** an event never moves a job backwards
  (`AT_OR_BEFORE`); the API's optimistic writes are corrected forward only.
- **Reorgs:** a changed cursor hash rewinds 2 × `confirmations` and replays. If
  any transaction already applied in that window has **no receipt any more**,
  the indexer throws "reorg dropped N transaction(s) … halting for an
  operator" on every tick and does not advance. `job_events` is append-only
  (a trigger refuses UPDATE and DELETE), so there is no automatic undo.
- **RPC failure:** a failing tick never kills the process; retries back off
  exponentially with ±20 % jitter up to `INDEXER_MAX_BACKOFF_MS` (60 s), and
  one success resets it. An RPC error during the reorg check is a failed tick,
  not a halt.
- **Chain → UI:** chain events → `job_events` / `jobs` / `payments` /
  `agent_stats` → API reads → interface. Indexer events are **not** pushed on
  SSE live (separate process, no bus); they appear on reconnect or refetch.
- **Scope:** only `TaskEscrow` is indexed. ERC-8004 registrations are
  verified on demand by the API (`chainAgentId`), not indexed. Jobs created
  directly on the contract, not through the API, are logged and skipped.

Backfill, reindex and repair procedures: [16 R3–R4](16-runbooks.md#r3-indexer-stopped-or-behind).

## 7. Database and migrations

- **Technology:** PostgreSQL 16, drizzle ORM (`packages/db/src/schema.ts`),
  `postgres.js` driver. Money is `NUMERIC(38,0)` base units.
- **Migrations:** plain SQL files applied in filename order by
  `packages/db/bin/migrate.mjs`, each in its own transaction, recorded in
  `_migrations`, serialised by a Postgres advisory lock. `DATABASE_URL` is
  required (no fallback). On Railway they run as the API's
  `preDeployCommand`; if a migration fails, Railway does not proceed with the
  deploy, and the failed file's transaction has rolled back.
- **Downtime review of every migration (2026-09-30):**

| File | Change | Lock / risk at today's size |
|---|---|---|
| `0000_gifted_shaman` | initial tables, FKs, indexes | new objects |
| `0001_constraints` | composite FKs, CHECKs, append-only trigger on `job_events` | validating ALTERs take ACCESS EXCLUSIVE on `jobs`; empty at the time |
| `0001_sudden_morlocks` | `runs`, `run_events` | new tables |
| `0002_chubby_rawhide_kid` | nullable `jobs.idempotency_key` + unique index | metadata-only column; the index build blocks writes to `jobs` |
| `0003_fine_scarlet_spider` | `x402_redemptions` | new table |
| `0004_sweet_tusk` | nullable `api_keys.key_id` + unique index | as 0002 |
| `0005_numerous_falcon` | `public_id uuid DEFAULT gen_random_uuid() NOT NULL` on `jobs` and `runs` + unique indexes | a **volatile default rewrites the table** under ACCESS EXCLUSIVE — seconds at thousands of rows; would need a batched backfill at millions |

  All of them are **additive**: the previous release's code runs against
  today's schema, which is what makes a code rollback safe. Future migrations
  should keep that property (add nullable, backfill, then constrain; never
  drop or rename in the same release that stops using a column). Because the
  runner wraps each file in a transaction, `CREATE INDEX CONCURRENTLY` cannot
  be used as written — a large-table index needs its own non-transactional
  step.
- **Rollback reality:** there are **no down migrations** (the runner has
  none, drizzle generates none). Rolling back means: redeploy the previous
  code (safe while migrations are additive) and, if a migration itself must be
  undone, write a new forward migration that reverses it — or restore a backup
  ([§8](#8-backup-and-disaster-recovery)).
- **Integrity** is enforced in the database, not only in code: chain-scoped
  composite FKs, `no_self_dealing`, `amount_positive`, `fee_within_amount`,
  `score_in_range`, kebab-case capabilities, unique idempotency keys, and the
  append-only trigger (tested in `packages/db/test/constraints.test.ts`).
- **Retention:** nothing is ever deleted. `job_events`, `run_events` and
  `signer_txs` grow without bound. Fine for a hackathon; a retention policy is
  an owner decision.

## 8. Backup and disaster recovery

- **No backups exist today** — there is no hosted database yet, and the local
  one is a dev volume the tests truncate.
- **Railway:** backups are a per-service feature to **enable** in the Postgres
  service's *Backups* tab: manual, or scheduled daily (kept 6 days), weekly
  (27 days) or monthly (89 days). Restoring creates a new volume from the
  chosen backup, in the same project and environment, and stages the change
  for review. Wiping a volume deletes its backups. (Railway docs, read
  2026-09-30.) **Owner action: enable daily + weekly before the demo.**
- **What can be rebuilt without a backup:** everything the indexer projects
  (job states, `payments`, `agent_stats`) can be re-derived from the chain for
  jobs whose rows exist. **What cannot:** agents' off-chain registrations
  (capabilities, prices, endpoints), API key hashes, job specs and results,
  run traces, the signer's nonce ledger. Losing the database means agents must
  re-register and receive new API keys.
- **Keys** are not in the database: they are Railway variables
  (`SIGNER_DEV_PRIVATE_KEYS` or `SIGNER_KEYSTORE_JSON`, `KEEPER_PRIVATE_KEY`).
  Keep an offline copy of the keystore and passphrase; losing both loses the
  agents' wallets.
- **Targets (proposed, owner decision):** RPO 24 h (daily backup), RTO 1 h
  (restore + redeploy). Neither has been rehearsed.

## 9. Security and access

- The signer is the crown jewel: private network only, `SIGNER_TOKEN`
  (≥ 32 chars, constant-time compare), loopback-only without it, raw keys
  refused off testnet, per-agent spend caps checked before signing (and
  enforced again on chain by an `AgentAccount`, with its allowlist).
- API: per-IP rate limit before auth; API keys stored as SHA-256 only; public
  UUIDs for jobs and runs; CORS required in production; helmet headers;
  endpoint URLs must be public https in production (SSRF guard).
- **Fixed 2026-09-30:** public `/ready` echoed dependency errors (which can
  name internal hosts); `/metrics` was open on the public API unless a token
  was set.
- **Open findings:** no API-key rotation or revocation endpoint (SQL only,
  R9); `POST /v1/agents` is unauthenticated and unthrottled beyond the IP limit
  (spam registrations are possible); the API returns "the signer did not
  answer: <message>" to callers, where the message is Node's own fetch error
  (no host in it today, but not guaranteed); the rate limit is per process.
- **Access:** GitHub (`CODEOWNERS`: owner reviews every path), Railway and
  Vercel accounts, and `.env` on the owner's machine. One person holds all of
  it — a bus-factor of one, and an owner decision.

## 10. Dependencies, CI/CD and release

- **Dependencies:** pnpm 9.12.0 (pinned), Node ≥ 22.12 (`.nvmrc` 22),
  lockfile frozen in CI and the image. Dependabot: weekly npm (minor/patch
  grouped), GitHub Actions and Docker base image. `pnpm audit --prod
  --audit-level high` in CI; run locally 2026-09-30: no known vulnerabilities.
- **CI** (`.github/workflows/ci.yml`, on push to `main` and every PR):
  - *static* — `pnpm typecheck` (sources and tests), `pnpm lint`,
    `pnpm format:check`, `check-no-secrets.mjs`, gitleaks over the full
    history, `pnpm audit --prod --audit-level high`;
  - *test* — checks out `agentx-contracts` beside it (needs
    `CONTRACTS_TOKEN` while that repo is private), `sync-chain-facts.mjs
    --check`, build, migrate, `vitest run --coverage` against a Postgres
    service with coverage floors (75/78/74/75);
  - *images* — builds api, signer, indexer from this repo alone, with the
    commit baked in, and asserts they run as non-root.
  The interface has its own CI (typecheck, lint, format, unit, audit, build,
  Playwright smoke against a mock API). The contracts repo has its own.
- **Pre-commit hook** (`.githooks/pre-commit`): secret scan, prettier and
  eslint on staged files.
- **CD:** none of our own. Railway builds and deploys on push to the tracked
  branch once connected; Vercel likewise. Nothing is pushed today (the local
  branch is ahead of `origin/main`).
- **Release process (proposed):** merge to `main` with CI green → Railway
  deploys api (migrations first), signer, indexer → `node
  scripts/check-deployment.mjs <api> <site>` → confirm `/v1/status`
  `build.commit` equals the merged commit. Details: [16 R1](16-runbooks.md#r1-deploy-and-verify).

## 11. Incident management

### Severities

| Sev | Meaning | Example | Response |
|---|---|---|---|
| SEV1 | Nothing works, or money/keys at risk | database down; signer key suspected leaked; wrong escrow served | now; stop the demo; rotate if keys |
| SEV2 | A core flow is broken | signer down (no hires); indexer halted; RPC down | within the hour |
| SEV3 | Degraded, workaround exists | indexer lagging; one worker down; keeper out of gas | same day |
| SEV4 | Cosmetic / no user impact | a log line, a doc | backlog |

### Process

1. **Declare** — note the time and the severity; one person owns it.
2. **Stabilise** — the runbook for the symptom ([16](16-runbooks.md)); roll
   back before debugging if a deploy caused it (R7).
3. **Communicate** — a maintenance/incident notice where users are (the
   submission page, the repo README) if it lasts beyond minutes.
4. **Verify** — `/v1/status` operational, `check-deployment.mjs` green.
5. **Review** — a postmortem for SEV1/SEV2 within two days, committed to
   `docs/incidents/YYYY-MM-DD-<slug>.md`.

### Templates

**Incident report**

```
# Incident YYYY-MM-DD — <one line>
Severity: SEV_  ·  Status: investigating | mitigated | resolved
Started: <UTC>  ·  Detected: <UTC, how>  ·  Resolved: <UTC>
Impact: <who could not do what, for how long>
Current state: <one paragraph>
Next update: <UTC>
```

**Postmortem**

```
# Postmortem — <incident title>
Summary: <what happened, impact, duration>
Timeline (UTC): <detected → mitigated → resolved, one line each>
Root cause: <the actual cause, not the trigger>
What went well / what did not:
Action items: | action | owner | due | issue |
Blameless: describes systems and decisions, not people.
```

**Maintenance notice**

```
AGENTX maintenance — <date>, <start>–<end> UTC
What: <e.g. database migration / redeploy>
Impact: <e.g. hires unavailable for ~2 min; browsing unaffected>
Status: <link to /v1/status or the site>
```
