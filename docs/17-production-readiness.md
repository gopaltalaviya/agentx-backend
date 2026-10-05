# 17 — Production readiness

Audit of the AGENTX backend's operations, 2026-09-30 (Session 27). Every row
names what was checked. Legend: ✅ implemented and verified · ⚠️ partial ·
❌ missing · 🔍 needs investigation · 🧑‍💻 owner decision.

Scope: `agentx-backend`, reading `agentx-contracts` and `agentx-interface`.
No hosted deployment exists (PROGRESS blocker B8), so nothing here was
verified on Railway or Vercel.

## Checklist

### Health, status, versioning

| | Item | Evidence |
|---|---|---|
| ✅ | Liveness `/health` on api, signer, indexer | `packages/service/src/http.ts`, `apps/api/src/app.ts`; tests in `service.test.ts`, `hardening.test.ts` |
| ✅ | Readiness `/ready` checks real dependencies (api: db + signer; signer: db + RPC; indexer: db + recent tick) | same; `apps/indexer/src/main.ts` |
| ✅ | Public `/ready` names a failed dependency without leaking its error | fixed this session; test injects an error naming an internal host and asserts it is absent |
| ✅ | Public `GET /v1/status` — components, indexer lag, build; cached, bounded, no internal detail | `apps/api/src/routes/status.ts`, 7 tests in `status.test.ts` (failed on the old code first); real response against Monad testnet captured 2026-09-30 |
| ✅ | Build metadata (version, commit, build time) on `/health` and `/v1/status` | `packages/service/src/build.ts` (3 tests); Dockerfile writes `/app/build-info.json`; local api image reported `a1f9485db5cc` + build time; CI asserts it |
| ✅ | Indexer lag metrics | `indexer_head_block`, `indexer_indexed_block`, `indexer_lag_blocks`; `progress()` tested; `verify-indexer.mjs` passed live on testnet |
| ✅ | API versioned by path (`/v1`) | every route in `apps/api/src/routes` |
| ⚠️ | Release tags / changelog | none; commit SHA is the identity. 🧑‍💻 whether to tag |

### API

| | Item | Evidence |
|---|---|---|
| ✅ | API reference, checked against the app | `docs/15-api.md`; test fails if a route is added or removed without the doc |
| ⚠️ | Machine-readable spec (OpenAPI) | not generated: routes validate with zod inside handlers, not Fastify schemas — a generator needs per-route schemas (a refactor). Bodies/responses in docs/15 are hand-read |
| ✅ | RFC 7807 errors with stable codes and `traceId` | `apps/api/src/errors.ts`, `packages/shared/src/errors.ts` |
| ✅ | Idempotency on money-moving routes (DB-enforced) | `Idempotency-Key` required on `POST /v1/jobs`, `/v1/x402/settle`; unique constraints in `0000`, `0002`; tests in `api.test.ts`, `x402.test.ts` |
| ⚠️ | Rate limiting | per IP, 600/min — per process, so N× with N replicas (docs/08) |
| ⚠️ | Pagination | bounded `limit` only, no cursor/offset (docs/15 §2) |
| ⚠️ | SSE | replay + heartbeat + clean shutdown work; no event ids (`Last-Event-ID` ignored), indexer events not pushed live, per-instance bus (docs/15 §3) |
| ✅ | `GET /v1/agents/:id` with a non-numeric id | was a **500** (`Number('abc')` reached Postgres) — found in this audit, fixed test-first (`hardening.test.ts`) |
| ❌ | API key rotation / revocation endpoint | SQL only (docs/16 R9) |

### Configuration and environments

| | Item | Evidence |
|---|---|---|
| ✅ | Env validated at boot, every problem listed | `packages/service/src/env.ts`; each `main.ts` has a zod schema |
| ✅ | Env var reference accurate | docs/08 §5 re-checked against every schema and `env` read; 17 names were missing, now listed |
| ✅ | Chain facts single-sourced, copies checked | `chain/` = contracts repo, `sync-chain-facts.mjs --check` in CI; interface reads `/v1/network` |
| ✅ | Secrets out of the repo | pre-commit + CI `check-no-secrets.mjs`, gitleaks full history in CI; `.env.example` names only |
| ✅ | Mainnet guarded | no `deployments/143.json` → config refuses; signer refuses raw keys and keeper refuses off testnet |

### Database

| | Item | Evidence |
|---|---|---|
| ✅ | Migrations ordered, transactional, locked, fail closed | `packages/db/bin/migrate.mjs`; run in CI and `docker-compose.full.yml` |
| ✅ | Migrations run before deploy | `deploy/railway/api.json` `preDeployCommand`; Railway does not proceed if it fails (Railway docs) |
| ✅ | Every migration reviewed for locking; all additive | docs/14 §7 (0005 rewrites `jobs`/`runs` — fine at current size) |
| ⚠️ | Rollback | no down migrations; code rollback safe while migrations stay additive (docs/14 §7) |
| ✅ | Integrity constraints in the database | `0001_constraints.sql`; `packages/db/test/constraints.test.ts` |
| ❌ | Backups | no hosted DB yet. 🧑‍💻 enable Railway daily + weekly backups on creation |
| ❌ | Retention policy | nothing is ever deleted. 🧑‍💻 |
| ❌ | Restore rehearsed | never |

### Indexer

| | Item | Evidence |
|---|---|---|
| ✅ | Idempotent replay | `replay.test.ts`; live `verify-indexer.mjs` 2026-09-30 ("replay is a no-op") |
| ✅ | Reorg detection and rewind | live check "reorg rewind replayed without duplicating anything" |
| ✅ | Halts (does not corrupt) on a deep reorg | `checkRewindWindow`; documented repair R4 (not rehearsed) |
| ✅ | RPC failure: backoff, never dies | `loop.test.ts` |
| ✅ | Forward-only state | `AT_OR_BEFORE`; Session 27 fix `b80db6f` |
| ⚠️ | Backfill / reindex tooling | SQL on the cursor (docs/16 R3); no script |
| 🔍 | Contracts redeploy against an old database | job ids restart at 1 vs `UNIQUE (chain_id, chain_job_id)` — derived, not observed (docs/16 R11) |

### Monitoring, alerting, incidents

| | Item | Evidence |
|---|---|---|
| ✅ | Structured logs with redaction and request ids | `packages/service/src/http.ts` |
| ✅ | Prometheus metrics per service | metric list in docs/14 §5, read from code |
| ✅ | `/metrics` not public by accident | api serves none in production without `METRICS_TOKEN` (tests) |
| ❌ | Alerting | none. 🧑‍💻 an uptime monitor on `/v1/status` + `/ready` (docs/14 §5) |
| ❌ | Error tracking, dashboards, metrics scraper | none |
| ❌ | Wallet balance monitoring (agents, keeper) | none; checked by hand before demos |
| ✅ | Severities, process, templates | docs/14 §11 |
| ✅ | Runbooks | docs/16, R1–R11; R1, R3, R8 rehearsed locally, the rest not |

### Deployment, CI/CD, security

| | Item | Evidence |
|---|---|---|
| ✅ | Images: one recipe, non-root, graceful SIGTERM | `Dockerfile`; CI asserts non-root |
| ✅ | CI: types, lint, format, secrets, audit, tests + coverage floors, image builds | `.github/workflows/ci.yml`; coverage 78.7/81.5/77.4/78.7 vs floors 75/78/74/75 |
| ✅ | Dependency updates | Dependabot weekly (npm, actions, docker); `pnpm audit --prod` clean 2026-09-30 |
| ⚠️ | CD | Railway/Vercel auto-deploy once connected; no staging environment |
| ✅ | Signer private, token-gated, loopback without a token | `apps/signer/src/auth.ts`; tests in `auth.test.ts` |
| ⚠️ | Registration abuse | `POST /v1/agents` unauthenticated, only the IP rate limit |
| 🧑‍💻 | Access / bus factor | one person holds GitHub, Railway, Vercel and every key |
| ❌ | Hosted deployment verified | blocked on accounts (B8) |

---

## Production Operations Readiness Report

### 1. Architecture
Four deployable services — api (public), signer (private, holds keys, runs the
keeper), indexer (private poller), optional worker bots — on one Postgres 16,
against Monad testnet, with the Next.js interface on Vercel. Flow and
placement: [14 §1](14-operations.md#1-architecture-and-data-flow).

### 2. Operational capabilities
Boot-time env validation; liveness/readiness per service; public status
summary; build identity; structured redacted logs with request ids;
Prometheus metrics; graceful shutdown; retrying, reorg-aware, idempotent
indexer; DB-enforced idempotency and integrity; locked, transactional
migrations; a deployment checker.

### 3. Endpoints
27 API routes — 24 under `/v1` plus `/health`, `/ready`, `/metrics` — indexed in
[15 §1](15-api.md#1-endpoint-index). Signer: `/health`, `/ready`, `/metrics`,
`POST /sign` (private). Indexer: `/health`, `/ready`, `/metrics` on
`INDEXER_HEALTH_PORT`. New this session: **`GET /v1/status`** (public).

### 4. API documentation status
Hand-written ([docs/15](15-api.md)), with a test that fails when the route
list and the document disagree. No OpenAPI: routes carry no Fastify schemas;
generating one is a per-route refactor, not done.

### 5. Versioning
Commit SHA is the release identity, baked into images and served; `/v1` for
the API; ordered forward-only migrations; contract deployments carry their
commit. [14 §3](14-operations.md#3-versioning).

### 6. Monitoring and alerting
Logs and metrics exist; alerting, error tracking and dashboards do not. The
smallest useful step is an external uptime monitor on `/v1/status` and
`/ready`; the alert table is [14 §5](14-operations.md#5-monitoring-and-alerting).

### 7. Deployment architecture
Railway for api, signer (private network only), indexer (one replica) and
managed Postgres; Vercel for the interface. SSE and in-process runs rule out
serverless for the API. Hetzner/VM via `docker-compose.full.yml` is viable
but moves TLS, backups and patching onto the owner.

### 8. Maintenance
Runbooks R1–R11 ([docs/16](16-runbooks.md)): deploy/verify, database down,
indexer behind/backfill/reindex, reorg halt and repair, RPC, recovery and
restart, rollback, manual migrations, secret rotation, dependency updates,
contracts redeploy.

### 9. Backup and recovery
None exist yet. Railway backups must be enabled on the Postgres service
(daily 6 d, weekly 27 d, monthly 89 d retention). Projections are
re-derivable from the chain; registrations, API keys, specs, results and run
traces are not. [14 §8](14-operations.md#8-backup-and-disaster-recovery).

### 10. Security findings
Fixed: public `/ready` echoed dependency errors (internal hostnames); `/metrics`
was public on the API unless a token was set; `GET /v1/agents/<non-numeric>`
answered 500. Open: no key rotation/revocation
endpoint; unauthenticated registration; signer fetch error message passed to
callers; per-process rate limit; single-person access. [14 §9](14-operations.md#9-security-and-access).

### 11. Missing capabilities
Alerting, error tracking, dashboards, backups, retention, a staging
environment, OpenAPI, SSE event ids, live indexer events, key management
endpoints, wallet balance monitoring, reindex tooling.

### 12. Implemented improvements (this session)
- `GET /v1/status` — public status summary, cached 5 s, 2 s per check.
- Build metadata on every service's `/health` (and `/v1/status`); the
  Dockerfile bakes commit + build time; CI passes and asserts the commit.
- Indexer head / indexed / lag gauges.
- `/ready` on the API no longer echoes errors; `/metrics` off in production
  without a token; a non-numeric agent id is a 409, not a 500.
- docs/14, 15, 16, 17; docs/08 variable list corrected; docs/13 and indexes
  linked; `.env.example` names added.

### 13. Remaining risks
One operator, no alerting and no backups — an outage or data loss would be
noticed late and could not be undone. A reorg halt needs a manual SQL repair
nobody has rehearsed. Model-provider availability decides whether hosted runs
work at all (Gemini 503s in Session 26). Testnet MON runs out silently.

### 14. Required owner decisions
1. Enable Railway Postgres backups (daily + weekly) when creating the database.
2. Pick an uptime monitor and point it at `/v1/status` and `/ready`.
3. Set `METRICS_TOKEN` on the API if metrics will be scraped (else none are served).
4. Whether to tag releases (`backend-v0.x.y`) and keep a changelog.
5. Data retention for `job_events`, `run_events`, `signer_txs`.
6. Agent key rotation: accept "new key = new wallet = re-register", or build tooling.
7. Whether registration (`POST /v1/agents`) needs a stricter limit or a gate.
8. RPO/RTO targets (proposed 24 h / 1 h).

### 15. Verification results
- Backend tests: **475 → 495 passed** (20 new, 1 changed). Run against the
  old code first: 18 of the new tests and the changed `/ready` assertion
  failed there, as intended; the 2 that passed both ways are regression
  guards for the already-existing token check on `/metrics`.
- Coverage 78.73 % statements / 81.51 % branches / 77.44 % functions /
  78.73 % lines (floors 75/78/74/75).
- `tsc -b`, test typecheck, `eslint .`, `prettier --check` on touched files:
  clean.
- Live: `scripts/verify-indexer.mjs` on Monad testnet — all 13 checks passed
  (settlement, linking, projection, reputation, replay no-op, reorg rewind).
- Live: `/v1/status` built from the compiled app against Monad testnet and
  the dev database — real head block, lag, `signer: "down"` (no signer
  running), `status: "degraded"`, no internal detail.
- Image: api image built from this repo with `GIT_SHA`; `buildInfo()` inside
  it reported the commit and build time; runs as uid 1000.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- Not verified: anything on Railway or Vercel; runbooks R2, R4–R7, R9–R11.

## Hostile input and worst-case testing (2026-10-01)

### 16. Hostile HTTP — `scripts/probe-api.mjs`
416 hostile requests against a running API; every write is one the API must
refuse, so it never spends. Run it with the optional knobs to cover the
stream cap and the rate limit:

```bash
PROBE_RUN_ID=<an open run> PROBE_MAX_STREAMS=5 PROBE_RATE_LIMIT=400 \
  node scripts/probe-api.mjs http://127.0.0.1:18098   # API started with SSE_MAX_STREAMS=5 RATE_LIMIT_PER_MINUTE=400
```

| Area | What was sent | Result |
|---|---|---|
| Bodies | malformed / empty / `null` / array / bare-string JSON, `text/plain`, form-encoded, 2 MB, 5 000-deep nesting, `__proto__` | 400 / 413 / 415 / 422, all RFC 7807 |
| Field values | negative, decimal, hex, exponent, 40-digit, Arabic-digit and blank prices; SQL injection, NUL, lone surrogate, RTL override, `<script>`, 100 emoji in names; 65-char name; 17 capabilities; `javascript:` endpoint | 422 `SCHEMA_MISMATCH`; nothing stored (row counts unchanged) |
| Query strings | SQL in `capability`, `limit=abc/-1/1e309`, `minScore=999`, `rank=../../etc`, repeated params, `%FF`, emoji, 10 KB | 422, or 400 `CHAIN_NOT_ENABLED` for a disabled chain |
| Ids and paths | non-numeric, negative, 23-digit, `%00`, `..%2F..`, `1'--`, serial and all-zero UUIDs, RTL mark; `DELETE` / `PUT` | 404 `NOT_FOUND` |
| Auth | no key, empty Bearer, garbage, right shape wrong key, Basic, SQL, CRLF, 8 KB key; x402 junk | 401 `UNAUTHORIZED`, same shape every time |
| CORS | preflight from `https://evil.example`; from the site | evil: no allow-origin; site: allowed; credentials never |
| Headers | any JSON response | CSP `default-src 'none'`, `nosniff`, frame options, no `x-powered-by` |
| Streams | `SSE_MAX_STREAMS` + 1 | 503 `UPSTREAM_UNAVAILABLE` + `retry-after: 5`; the API keeps serving; a closed stream frees its slot |
| Rate limit | 400/min + 20 | 429 `RATE_LIMITED` + `retry-after`; **`/health` and `/ready` exempt** (fixed — see below) |
| Leaks | every response body | no stack frame, filesystem path, connection string or internal address |

**Zero 500s.** One real bug: `/health` and `/ready` were rate limited, so a
client that spent its budget made a healthy instance look dead to a load
balancer sharing its egress IP. Fixed; `hardening.test.ts` fails on the old
code. `SSE_MAX_STREAMS` is new (default 1000).

### 17. Worst cases — one dependency down at a time
On `docker-compose.full.yml` (the production images, own Postgres on :5443,
API on :18180) with the site pointed at it. Each row was observed live on
Monad testnet, then the dependency was brought back.

| Broken | `/ready` | `/v1/status` | What the site shows | Recovers by itself |
|---|---|---|---|---|
| Signer stopped | 503 | degraded — **signer down only** | Status: "Signer — Down. New hires and payments cannot be signed; browsing and records still work." | Yes |
| Database stopped | 503 | **down** | Status: "Major outage — funds in escrow are safe on chain". Marketplace / profile: "AGENTX is temporarily unavailable…" + Retry | Yes, no API restart |
| Indexer stopped | 200 | degraded; indexer **down** after 120 s | Status: "Indexer — Down. Stopped — no progress for 3 min, with blocks waiting to be indexed." Marketplace keeps serving | Yes ("Catching up" again) |
| API stopped | — | — | Header badge "API unreachable"; status: "The API cannot be reached… escrow is safe and has a permissionless way out"; marketplace: "Cannot reach the AGENTX API" + Retry | Yes |
| RPC black-holed (`10.255.255.1`) | 200 | degraded — rpc **down**, answered in **2.0 s** | Status: "Chain connection — Down. The chain is not answering us…" Marketplace serves in 7 ms | Yes |

No uncaught browser errors in any row. Three bugs found and fixed, each with
a test that fails on the old code:

1. **Signer down reported the chain down too.** Every `/ready` and
   `/v1/status` probed the stopped signer; each DNS lookup held one of
   libuv's four threads for ~4 s and the RPC lookup queued behind them —
   measured 7 665 ms vs 5 ms. Fix: the signer probe is coalesced (one in
   flight, answer reused 5 s; `coalesce.test.ts`) and the image sets
   `UV_THREADPOOL_SIZE=16`. Re-checked live: five reads in a row, RPC up.
2. **Database down answered 500 `INTERNAL`** — "our bug, don't retry". Now
   503 `UPSTREAM_UNAVAILABLE` + `retry-after: 5`, naming no host
   (`hardening.test.ts`). postgres.js `connect_timeout` 30 s → 10 s, so a
   vanished (not refusing) database fails a request in seconds, not half a
   minute.
3. **A stopped indexer read "degraded"**, the same as one catching up.
   Behind *and* silent for over 120 s is now "down"; an idle, caught-up
   indexer on a quiet chain stays "up" (`status.test.ts`, both cases).

The site's wording changed with them: a 503 reads "temporarily
unavailable", any other 5xx "The API had a problem (N)", never a raw path or
an operator's detail, and the shared messages no longer promise "nothing was
spent" — they are used for writes too, where the site cannot know that.

Also observed: `docker compose … up --build` of four images in parallel
twice lost Docker Desktop's BuildKit connection (`EOF`) and once took the
dev Postgres container down with it (exit 255, no shutdown in its log).
Building with `COMPOSE_PARALLEL_LIMIT=1` was reliable. Not a code issue; a
note for anyone building the full stack on a laptop.

After the matrix: `check-deployment.mjs` against the isolated stack — all
checks passed; `verify-indexer.mjs` on Monad testnet — all 13 passed.

### 18. Browser edge cases — `agentx-interface/e2e/edge.spec.ts`
18 tests, deterministic (the API is made to misbehave with `page.route`):
double-click and Ctrl+Enter spam on Run send exactly one `POST /v1/runs`;
the key is trimmed and sent only in `Authorization`; a 500 on marketplace,
profile and run record shows a readable error and Retry recovers; a hanging
API shows loading; malformed JSON and an unreachable API read as sentences;
XSS strings stay inert; null fields render; 100 agents and a 500-event trace
render; every step status is named in words; register refuses what the API
would (64 / 1 000 / 16 / uint128); a dropped live stream says so and links
to the run record; a 300-character name, RTL and emoji do not scroll a
phone sideways; the header fits 320 px; a stopped indexer is told apart
from one catching up. Five of these found real bugs, fixed in the same
change.

### 19. Found while recording the guides, and the chaos re-run
Recording the video guides against a held demo on Monad testnet found four
more defects, all fixed:

1. **A finished run could show no answer.** The API published `finished`
   before writing the answer and step outcomes; the page read the record
   once, at that instant. One take showed a finished run with no answer.
   Now the result is written first, then the event, then the state
   (`runs.test.ts` slows every UPDATE by 300 ms so the race is lost every
   time on the old order), and the page re-reads while the record still
   says `running` (`edge.spec.ts`).
2. **A leftover signer hijacked the next demo.** A stopped terminal left the
   previous demo's signer holding :7098; the new one died with
   `EADDRINUSE`, the old one answered the health check with a different
   token, and every hire failed "the signer answered 401". `demo.mjs` now
   refuses to start if either port is taken (before anything is spent) and
   treats any service exiting on its own as fatal.
3. **The demo rate-limited itself.** Every simulated agent calls from
   127.0.0.1, so they shared one 600/min bucket and the workers were
   refused as a run added traffic (also present before this session: 81
   `RATE_LIMITED` lines in an earlier held demo). The demo's own API now runs
   at 20 000/min; production is unchanged.
4. **A drained FUNDER read as "transaction reverted".** The demo now checks
   the gas payer covers the agents' top-ups before sending, and says which
   account to fund (or to unset `FUNDER_PRIVATE_KEY` so the deployer pays).

**Chaos re-run** — `slow-rpc.mjs` at 20 % failures and 30 % on broadcasts,
every service and the demo's own setup behind it (the harness now retries
six times, not three, so it tests the system rather than the setup script):
1 000 RPC requests, 211 failed, 49 of 121 broadcasts refused, 1.2 s average
delay; **3/4 settled in 729 s, the fourth refunded**. Its worker's accept,
slowed by the refused broadcasts, arrived after the orchestrator's
acceptance window: the job had already been cancelled and refunded, and the
contract refused the late accept (`InvalidState`). That is the designed
outcome. Every safety assertion passed: nothing hung, workers paid 0.099,
spend inside the on-chain daily cap, stolen-key calls refused, `SameOwner`
and `AmountBelowMinimum` refused, earnings swept, reputation written from
settlement. Session 27's run at the same setting settled 4/4; at this loss
rate the count depends on which broadcasts fail.

### 20. Hosted live runs — rehearsed end to end (2026-10-05)
The production images plus the three worker bots (`docker compose --profile
hosted`), a fresh database, the API in live mode on the owner's Gemini key,
agents seeded with `scripts/seed-hosted.mjs` on Monad testnet, and the real
site driven like a judge: paste the orchestrator key, **Run**.

**Result:** the run planned 2 subtasks, hired 2 agents through escrow, judged
both and settled both on chain in 151 s; the answer card showed; the indexer
(started at the head with `INDEXER_START_AT_HEAD=1`) wrote both workers'
reputation; `/v1/status` was operational within seconds of a fresh start.
Gas measured: 0.14 MON from the orchestrator's session key, 0.034 per hired
worker — 0.21 MON a run.

| Also proven live | Result |
|---|---|
| Daily session-key renewal | with the window forced to 24 h, the signer's renewer re-granted all four accounts' keys on chain (expiry read before and after; budgets kept) |
| Run cap | with `RUNS_PER_DAY=1`, the second run was refused on the site: "this orchestrator has started 1 run in the last 24 hours, its limit" |
| Deployment checks | `check-deployment` green (with an orchestrator now), `probe-api` 86 requests clean, every page clean in Chromium, Firefox and WebKit |
| Retiring agents | `seed-hosted.mjs --reclaim` returned 6.38 MON from the rehearsal keys to FUNDER |

**What it took — six defects, each fixed with a test that fails on the old
code:**

1. **The images could not be built reliably.** `pnpm -r build` compiled all
   14 packages in parallel in every image; concurrent `tsc -b` over shared
   project references segfaulted or hung (a worker image hung 35 min).
   Each image now builds only its service and its dependencies, one at a time:
   seven images in 110 s.
2. **A transient model error ended the run.** Gemini answered 503 "high
   demand … usually temporary" and the provider gave up at once. Transient
   statuses (429, 500, 502, 503, 504) and dropped connections are retried
   twice with backoff (honouring `retry-after`); a timeout or a client error
   is not.
3. **One overloaded model was a dead end.** `gemini-3.8-flash` and `3.7` were
   refusing while `3.6`, `3.5` and `flash-latest` answered. A chain can now
   name models — `BRAIN_CHAIN=gemini:gemini-3.6-flash,gemini:gemini-flash-latest,gemini`.
4. **A thinking model ran out of tokens mid-answer.** Gemini 3.x spends
   `maxOutputTokens` on thinking first; a worker's triage asked for 400 and
   got `{"`. Gemini now gets 8 192 of headroom (billing is per token produced),
   and a reply cut off at the limit is a provider failure, so the chain moves
   on.
5. **JSON wrapped in prose failed the job.** "Here is the JSON requested:"
   and a fenced block — valid JSON inside — was rejected. The parser now takes
   plain JSON, else the first fenced block, else the outermost object; the
   schema still validates it.
6. **A second run with the same goal could never hire.** The hire's
   idempotency key was derived from worker and spec only, so the second run
   got the first run's job back — already refunded. Keys are now per run. The
   demo never showed it: it runs once per set of agents.

Recorded too: Gemini returned 429 "rate limited" once mid-run; with the model
chain and retries the next run completed.
