# 16 — Runbooks

Each runbook: **when**, **preconditions**, **steps**, **validation**,
**rollback**, **expected result**. Background for all of them is
[14 — Operations](14-operations.md). First-time setup is
[13 — Deploy](13-deploy.md).

**Status of these procedures.** Steps that were run for real are marked
✅ *rehearsed*; everything else is derived from the code and Railway/Vercel
documentation and has **not** been run against a hosted deployment, because
none exists yet. Treat an unrehearsed runbook as a checklist to verify the
first time.

Conventions: `$API` is the API's public URL; `psql "$DATABASE_URL"` means a
SQL session on the target database (on Railway: the Postgres service's
*Connect* tab gives a public URL and a `railway connect` command). Testnet
only — any mainnet action needs explicit confirmation first.

| # | Runbook |
|---|---|
| R1 | [Deploy and verify](#r1-deploy-and-verify) |
| R2 | [Database down](#r2-database-down) |
| R3 | [Indexer stopped or behind · backfill · reindex](#r3-indexer-stopped-or-behind) |
| R4 | [Indexer halted on a reorg, or showing wrong data](#r4-indexer-halted-on-a-reorg-or-showing-wrong-data) |
| R5 | [RPC down or rate-limited · change the RPC](#r5-rpc-down-or-rate-limited) |
| R6 | [Recover a failed service · restart](#r6-recover-a-failed-service) |
| R7 | [Roll back a deploy (backend, frontend)](#r7-roll-back-a-deploy) |
| R8 | [Run migrations by hand](#r8-run-migrations-by-hand) |
| R9 | [Rotate secrets and keys](#r9-rotate-secrets-and-keys) |
| R10 | [Update dependencies](#r10-update-dependencies) |
| R11 | [After a contracts redeploy](#r11-after-a-contracts-redeploy) |

---

## R1. Deploy and verify

**When:** shipping backend and/or interface changes.
**Preconditions:** CI green on the commit; `chain/` in sync (CI checks);
any new migration is additive ([14 §7](14-operations.md#7-database-and-migrations)).

**Steps**

1. Merge / push to the branch Railway and Vercel track.
2. Railway builds each service from the same commit. Order matters only on
   first deploy (signer before api: the api's health check is `/ready`, which
   needs the signer). The api runs migrations as its `preDeployCommand`; a
   failed migration stops the api deploy and leaves the previous version
   serving.
3. Vercel rebuilds the interface. If `NEXT_PUBLIC_API_URL` changed, this
   rebuild is required — it is read at build time.

**Validation** ✅ *rehearsed against local production images (2026-09-30)*

```bash
node scripts/check-deployment.mjs "$API" https://<site>
curl -s "$API/v1/status"       # status "operational"; build.commit = the merged commit (12 chars)
curl -s "$API/health"          # chains[].escrow = chain/deployments/<id>.json TaskEscrow
```

**Rollback:** R7. **Expected:** every check passes; `build.commit` matches.

## R2. Database down

**Symptom:** `/v1/status` `status: "down"`, `components.database: "down"`;
`/ready` 503 `database.ok: false` on api, signer, indexer; API requests 503
`UPSTREAM_UNAVAILABLE` with `retry-after: 5`.

1. Railway → Postgres service: is it running, is the volume full, is there a
   platform incident? The API logs `readiness check failed` with the real
   driver error (the public response deliberately omits it).
2. Restart the Postgres service if it crashed. The api, signer and indexer
   reconnect by themselves (pooled `postgres.js`); restart them only if
   `/ready` stays 503 after the database is up.
3. If the data is lost or corrupt: restore from a Railway backup (Postgres
   service → *Backups* → restore, which stages a new volume for review), then
   redeploy the api so migrations run against it. **Only possible if backups
   were enabled** ([14 §8](14-operations.md#8-backup-and-disaster-recovery)).
4. After a restore, the indexer's cursor is as old as the backup: it re-reads
   from there, idempotently, and catches up (R3).

**Validation:** `/ready` 200 everywhere; `/v1/status` operational.
**Expected:** service resumes; hires made during the outage failed with 503
`UPSTREAM_UNAVAILABLE` and are safe to retry under the same `Idempotency-Key`.

## R3. Indexer stopped or behind

**Symptom:** `/v1/status` `components.indexer: "degraded"` (lag > 150 +
confirmations) or `"down"` (behind, and no progress for 120 s — stopped, not
catching up), or `lastIndexedAt` old while `rpc: "up"`; indexer `/ready`
503 ("no successful tick for N s"); jobs stuck in their API-written state.

**Diagnose**

```sql
SELECT chain_id, last_block, updated_at, now() - updated_at AS age FROM indexer_cursor;
```

- Logs say `tick failed, retrying` / `indexer is failing` → the error is the
  cause (usually RPC: R5; or database: R2).
- Logs say `reorg dropped … halting` → R4.
- Ticks succeed but lag is large → it is **backfilling**. At 100 blocks per
  tick and one tick per `INDEXER_POLL_MS` (2 s), it gains ~50 blocks/s minus
  the chain's own rate; Monad testnet produces a few blocks per second.
  Waiting is correct.

**Restart:** restart the indexer service. Safe at any moment: the cursor is
written after a batch, and a re-read batch is a no-op.

**Backfill a range** (re-read blocks from `N`, e.g. after an RPC returned
incomplete logs):

1. Stop the indexer service (a running tick would overwrite the cursor).
2. Get block `N`'s hash — `cast block N --rpc-url <rpc> -f hash`, or
   `eth_getBlockByNumber`.
3. ```sql
   UPDATE indexer_cursor SET last_block = <N>, last_block_hash = '<hash of N>', updated_at = now()
   WHERE chain_id = 10143 AND contract = 'TaskEscrow';
   ```
   A wrong hash is not dangerous: the next tick treats it as a reorg, rewinds
   2 × confirmations, finds every recorded transaction still on chain and
   carries on.
4. Start the indexer.

**Full reindex from the deployment block:** stop the indexer,
`DELETE FROM indexer_cursor WHERE chain_id = 10143 AND contract = 'TaskEscrow';`,
start it. It resumes at `startBlock` from `chain/deployments/10143.json`.
Existing events are skipped, missing ones applied. For the current testnet
deployment (start block 66 905 096, head ~66 983 000 on 2026-09-30) that is
~780 ticks, roughly half an hour.

What a reindex does **not** do: undo effects already applied (reputation,
payments), recreate jobs the API never wrote, or index anything but
`TaskEscrow`.

**Validation:** `/v1/status` indexer `up`, `lagBlocks` near `confirmations`.
**Rollback:** set the cursor back to where it was (note it before step 3).
Replay idempotency was ✅ *re-verified live on Monad testnet on 2026-09-30*
(`scripts/verify-indexer.mjs`: replay no-op, reorg rewind without duplicates).

## R4. Indexer halted on a reorg, or showing wrong data

**Halt symptom:** every tick fails with `reorg dropped N transaction(s) this
indexer had already applied: 0x…, 0x… — … halting for an operator`. This
takes a reorg deeper than the confirmation depth (2 on testnet) — rare.

**Why it halts:** those transactions' events are in the append-only
`job_events` and their effects are in `jobs`, `payments`, `agent_stats`. The
chain no longer backs them, and there is no automatic undo.

**Repair** (not rehearsed — do it in a transaction, on a backup first if you
have one):

1. Stop the indexer. Save the listed transaction hashes.
2. Inspect what they touched:
   ```sql
   SELECT e.job_id, e.kind, e.block_number FROM job_events e WHERE e.tx_hash IN ('0x…');
   SELECT * FROM payments WHERE tx_hash IN ('0x…');
   ```
3. Check each on chain (`cast receipt <hash>` → not found; and
   `cast call <TaskEscrow> "getJob(uint256)" <chainJobId>` for the job's
   real state).
4. Remove the orphaned rows and correct the projection. `job_events` refuses
   DELETE by trigger, so the repair must disable it explicitly:
   ```sql
   BEGIN;
   ALTER TABLE job_events DISABLE TRIGGER job_events_no_update;
   DELETE FROM job_events WHERE tx_hash IN ('0x…');
   DELETE FROM payments  WHERE tx_hash IN ('0x…');
   -- set each affected job's state to what getJob() reports
   UPDATE jobs SET state = '<state>' WHERE id = <job_id>;
   ALTER TABLE job_events ENABLE TRIGGER job_events_no_update;
   COMMIT;
   ```
5. Reputation: `agent_stats` counters were incremented by the dropped
   settlements. Decrement `completed`/`volume` (or `failed`) for the affected
   worker by what those events added, then recompute `score` with the formula
   in `Indexer.bumpReputation` (`apps/indexer/src/indexer.ts`). There is no
   tool for this; it is a hand calculation.
6. Start the indexer. It rewinds, finds nothing orphaned, and re-applies any
   re-mined transactions correctly.

**"Wrong data" without a halt:** compare the job with the chain
(`getJob(chainJobId)`), and the API's view (`GET /v1/jobs/:id` events). The
indexer only moves states forward and is authoritative for chain facts; the
API writes optimistic states the indexer later confirms. A job stuck in an
API-written state with no chain event means the transaction never landed —
check the signer's `signer_txs` row for its `tx_hash` and status.

**Validation:** ticks succeed; `/v1/status` indexer `up`; the repaired jobs
match `getJob`.

## R5. RPC down or rate-limited

**Symptom:** `/v1/status` `rpc: "down"`; indexer logs `tick failed` with HTTP
errors or 429s; signer `/ready` `rpc.ok: false`; hires fail
`UPSTREAM_UNAVAILABLE`.

1. Confirm it is the RPC: `curl -s -X POST <rpc> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`.
2. If the public endpoint is down or limiting: set `RPC_URL_10143` to another
   endpoint (a keyed provider is fine — it is never served to clients) on
   **each** of api, signer and indexer, and redeploy them. Nothing else
   changes; `networks.json` stays the public default.
3. Nothing to replay afterwards: the indexer backs off (≤ 60 s between
   attempts) and resumes from its cursor on the first success.

**Validation:** `/v1/status` `rpc: "up"`, indexer lag falling.
**Rollback:** unset `RPC_URL_10143` and redeploy.
`scripts/slow-rpc.mjs` is a local proxy that injects delay and failures, for
rehearsing this without an outage.

## R6. Recover a failed service

**Symptom:** a service crash-loops, or a Railway health check fails.

1. Read the service's latest logs. Boot failures are explicit and list every
   problem at once:
   - `invalid environment:` — a variable missing or malformed (names each).
   - `AGENTX config invalid` — chain facts: e.g. `ENABLED_CHAIN_IDS` names a
     chain with no `deployments/<id>.json`.
   - `CORS_ORIGINS is required when NODE_ENV=production` (api).
   - `SIGNER_HOST=… without SIGNER_TOKEN` (signer refuses to expose itself).
   - `unhandled promise rejection` / `uncaught exception` — the process shuts
     down deliberately (exit 1) and Railway restarts it (`ON_FAILURE`, up to
     10 retries).
2. Fix the variable/config and redeploy; or roll back (R7) if a new release
   caused it.
3. **Restart** a healthy-but-stuck service: Railway → service → *Restart*.
   Shutdown is graceful: SIGTERM stops accepting, ends SSE streams (clients
   reconnect in 3 s), drains in-flight requests, closes pools, within 10 s.

**Validation:** `/ready` 200; `/v1/status` operational.

## R7. Roll back a deploy

**Backend (Railway):** service → *Deployments* → the previous successful
deployment → *Redeploy* (per service: api, signer, indexer). Safe for the
database **because every migration so far is additive** — the previous code
runs on the newer schema. A migration is never rolled back by redeploying;
reversing one needs a new forward migration or a backup restore
([14 §7](14-operations.md#7-database-and-migrations)).

**Frontend (Vercel):** project → *Deployments* → the previous production
deployment → *Promote to Production* / *Instant Rollback*. If the API URL
changed between the two, the old build still points at the old URL (baked
in at build time).

**Validation:** `/v1/status` `build.commit` shows the previous commit; R1's
checks pass.

## R8. Run migrations by hand

**When:** a pre-deploy migration failed, or a database was restored.

```bash
# From a checkout at the deployed commit, against the target database
DATABASE_URL='<postgres url>' pnpm --filter @agentx/db migrate
# or from any built image of this repo
node node_modules/@agentx/db/bin/migrate.mjs   # (api image; working dir /app)
```

Output: `✓ <file>` per applied file, then `applied N migration(s)` or
`already up to date`. Concurrent runs are serialised by an advisory lock. A
failing file prints `✗ <file>` and its error, exits 1, and leaves that file
unapplied (its transaction rolled back); later files are not attempted.

✅ *rehearsed* locally in every CI run and in `docker-compose.full.yml`
(`migrate` service). **Never** edit or rename an applied file — the ledger
records names.

## R9. Rotate secrets and keys

Every secret lives in Railway variables (hosted) or `.env` (local); never in
a commit, a log or chat. After any rotation: redeploy the affected services,
then R1's validation.

| Secret | Where | Rotate by | Impact during rotation |
|---|---|---|---|
| `SIGNER_TOKEN` | shared variable → api + signer | `openssl rand -hex 24`, update the shared variable, redeploy **signer then api** | between the two restarts, api → signer calls answer 401 → callers get `UPSTREAM_UNAVAILABLE` (retry-safe) |
| `METRICS_TOKEN` | api (+ signer/indexer if set) | new value, redeploy, update the scraper | scrapes fail until updated |
| `KEEPER_PRIVATE_KEY` | signer | new key, **fund it with MON**, update, redeploy; drain the old one | none; if unfunded, `keeper_exits_total{outcome="failed"}` rises |
| Agent signing keys (`SIGNER_DEV_PRIVATE_KEYS` / keystore) | signer | a new key is a **new wallet**: the agent's ERC-8004 registration and `walletAddress` must change with it. No tooling exists — owner decision | the agent cannot sign until re-registered |
| Model keys (`GEMINI_API_KEY` …) | api, workers | rotate at the provider, update, redeploy | runs fail until updated |
| `DATABASE_URL` password | Postgres service | Railway Postgres settings; services reference `${{Postgres.DATABASE_URL}}`, so redeploy them | brief connection errors |
| Agent API keys (`ax_…`) | database | see below | the old key stops at once |

**Revoke an agent API key** (no endpoint exists):

```sql
UPDATE api_keys SET revoked_at = now() WHERE key_id = '<16-hex id from ax_<id>_…>';
```

**Issue a replacement key** for agent `<agentId>` (no endpoint exists). On a
checkout with `pnpm -r build` done, generate a key and its hash locally — the
key is printed once, give it to the agent's owner and do not paste it
anywhere else:

```bash
node -e "import('./apps/api/dist/auth.js').then(({generateApiKey,hashApiKey})=>{const k=generateApiKey();console.log(k.key);console.log(k.keyId, hashApiKey(k.key))})"
```

```sql
INSERT INTO api_keys (agent_id, key_id, key_hash, scopes)
VALUES (<agentId>, '<keyId>', '<sha256$…>', '{client,worker}');
```

(The generator was run on 2026-09-30 and produces the expected shapes; the
SQL insert has not been exercised against a hosted database.)

**Suspected key leak (SEV1):** revoke/rotate first, then investigate. For a
signing key: move its funds with a transaction from the same key before the
attacker does; the per-agent caps bound what a stolen API key can spend, not
what a stolen private key can.

## R10. Update dependencies

1. Dependabot opens weekly grouped PRs (npm minor/patch, Actions, Docker).
   CI must pass: types, lint, format, secrets, audit, tests with coverage
   floors, image builds.
2. By hand: `pnpm update --recursive` (or a named package), `pnpm install`,
   then `pnpm check` (typecheck + lint + format + tests) and
   `docker compose -f docker-compose.full.yml up --build` for the images.
3. Majors (Fastify, drizzle, viem, zod) one at a time, each with a live check:
   `scripts/verify-indexer.mjs` on testnet for anything touching the chain
   path.

**Rollback:** revert the commit; the lockfile pins the old versions.

## R11. After a contracts redeploy

A redeploy gives new addresses, a new `startBlock` and job ids that start
again at 1.

1. `node scripts/sync-chain-facts.mjs` (with `AGENTX_CONTRACTS_ROOT` at the
   contracts checkout) and commit `chain/`; CI fails until you do.
2. **Reset the indexer cursor** to the new deployment:
   `DELETE FROM indexer_cursor WHERE chain_id = <id>;` with the indexer
   stopped. The cursor is keyed by chain and contract *name*, not address:
   left alone, an indexer that had already passed the new `startBlock` would
   skip the new escrow's first events.
3. **Use a fresh database, or clear the old deployment's jobs.** On-chain job
   ids restart at 1 and `jobs` is unique on `(chain_id, chain_job_id)`: a new
   job whose id matches an old row's cannot be linked, and the indexer's tick
   would fail on the conflict. (Derived from the schema and `TaskEscrow`'s
   `nextJobId = 1`; not observed, because every redeploy so far used a
   truncated dev database.)
4. Redeploy api, signer, indexer; R1 validation — `check-deployment.mjs`
   compares the escrow the API serves with `chain/`.
