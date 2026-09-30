# 13 — Deploying AGENTX: Railway + Vercel

The whole hosted deployment, step by step. Everything here was rehearsed on
2026-09-30 against the same production images, built the way Railway builds
them (one repo, no sibling checkout), with the signer bound the way Railway's
private network needs it — then checked with `scripts/check-deployment.mjs`.
What was not rehearsed is Railway and Vercel themselves: that needs your
accounts.

```
             Vercel                         Railway (one project)
   ┌─────────────────────┐        ┌───────────────────────────────────────────┐
   │ agentx-interface    │ HTTPS  │ api ──(private net, SIGNER_TOKEN)──▶ signer │
   │ NEXT_PUBLIC_API_URL ├───────▶│  │                                   │    │
   └─────────────────────┘        │  └──────────▶ Postgres ◀── indexer ◀─┘    │
                                  │        workers (optional) ──▶ api          │
                                  └───────────────────────────────────────────┘
                                                   │
                                          Monad testnet (10143)
```

Only `api` gets a public domain. The signer holds the keys and is reachable
only over Railway's private network, and only with `SIGNER_TOKEN`.

---

## 0. Before you start

- `agentx-backend` builds **from itself alone**. The chain facts every image
  carries (networks, parameters, addresses, ABIs) are in `chain/`, a committed
  copy of `agentx-contracts`. After any redeploy of the contracts:
  `node scripts/sync-chain-facts.mjs` and commit `chain/` — CI fails until you do.
- Generate the shared token once: `openssl rand -hex 24`. Keep it out of chat
  and out of any committed file.
- Decide the model. Railway has no Ollama, so a hosted run needs a hosted
  key (`GEMINI_API_KEY`, `GROQ_API_KEY` or `ANTHROPIC_API_KEY`). **That spends
  your quota** on every run someone starts from the site. Without a key the
  site still browses — marketplace, profiles, run history, registration — and
  `/health` says `orchestrator: false`.

## 1. Railway

Create a project, then add, in this order:

### 1.1 Postgres

**+ New → Database → PostgreSQL.** Nothing to configure.

### 1.2 Shared variable

Project **Settings → Shared Variables**: `SIGNER_TOKEN` = the token from §0.

### 1.3 Services

Each is **+ New → GitHub Repo → `agentx-backend`**, then in the service's
**Settings**: set **Config-as-code file path** to the file named below, and
rename the service to the name given (the variable references below use it).

Railway passes service variables to the Docker build, so `SERVICE` picks which
app the image contains.

#### `signer` — `deploy/railway/signer.json` · no public domain

| Variable | Value |
|---|---|
| `SERVICE` | `@agentx/signer` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `ENABLED_CHAIN_IDS` | `10143` |
| `DEFAULT_CHAIN_ID` | `10143` |
| `SIGNER_TOKEN` | `${{shared.SIGNER_TOKEN}}` |
| `SIGNER_HOST` | `::` — Railway's private network is IPv6 |
| `SIGNER_PORT` | `7070` |
| `PORT` | `7070` — so Railway's health check reaches `/ready` |
| `SIGNER_DEV_PRIVATE_KEYS` | the agents' keys, comma-separated; each agent is matched to its key by its registered wallet address, so distinct agents need distinct keys (testnet only — the signer refuses raw keys on any other chain). Or `SIGNER_KEYSTORE_JSON` + `SIGNER_KEYSTORE_PASSPHRASE` |
| `KEEPER_PRIVATE_KEY` | a gas-only key the signer never signs for — enables the keeper (expired jobs, `expireDispute`) |

#### `api` — `deploy/railway/api.json` · **generate a public domain**

Migrations run before each deploy (`preDeployCommand`), from this image.

| Variable | Value |
|---|---|
| `SERVICE` | `@agentx/api` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `ENABLED_CHAIN_IDS` | `10143` |
| `DEFAULT_CHAIN_ID` | `10143` |
| `HOST` | `::` |
| `PORT` | `8080` — fixed, so the workers' private URL below is stable |
| `SIGNER_URL` | `http://${{signer.RAILWAY_PRIVATE_DOMAIN}}:7070` |
| `SIGNER_TOKEN` | `${{shared.SIGNER_TOKEN}}` |
| `TRUST_PROXY` | `1` — rate limits by the caller, not Railway's proxy |
| `CORS_ORIGINS` | the Vercel URL, exactly, e.g. `https://agentx.vercel.app` (§2 gives it; until then any placeholder — the API refuses to boot in production without one) |
| *model, optional* | `GEMINI_API_KEY` (or Groq / Anthropic), `BRAIN_CHAIN_ORCHESTRATOR=gemini`, `AGENT_MODE=live` |

`/ready` answers 503 until the signer is up — that is correct, and why the
signer goes first.

#### `indexer` — `deploy/railway/indexer.json` · no public domain

| Variable | Value |
|---|---|
| `SERVICE` | `@agentx/indexer` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `ENABLED_CHAIN_IDS` | `10143` |
| `DEFAULT_CHAIN_ID` | `10143` |
| `INDEXER_HEALTH_PORT` | `9090` |
| `PORT` | `9090` |

#### Workers — `deploy/railway/worker.json` · optional

The three bots (`@agentx/research-bot`, `@agentx/trading-bot`,
`@agentx/execution-bot`) can run anywhere that reaches the API — a laptop is
fine for the demo. Hosted, each is one service with:

| Variable | Value |
|---|---|
| `SERVICE` | e.g. `@agentx/research-bot` |
| `AGENTX_API_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:8080` |
| `AGENTX_API_KEY` | the key `POST /v1/agents` returned when that worker registered (shown once) |
| `AGENTX_CHAIN_ID` | `10143` |
| model | a hosted key and `BRAIN_CHAIN` naming it, `AGENT_MODE=live` |

## 2. Vercel

**Add New → Project → import `agentx-interface`.** Framework: Next.js
(detected). One environment variable, for Production:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | the Railway API domain, e.g. `https://agentx-api-production.up.railway.app` |

It is read **at build time** — the CSP is built from it — so changing it
needs a redeploy, not just a restart. The build fails on purpose if it is
missing.

Then go back to Railway and set the API's `CORS_ORIGINS` to the Vercel URL.

## 3. Check it

```bash
cd agentx-backend
node scripts/check-deployment.mjs https://<api-domain> https://<vercel-domain>
```

Read-only, no key. It checks that the API serves the escrow this repo was
built for, is ready (database *and* signer), does not enumerate jobs or runs,
sends security headers, lets the site in and nobody else through CORS — and
that the site answers, its CSP can reach the API, and unknown runs are real
404s. Each failure says what to change. Rehearsed against the production
images on 2026-09-30: every check passed, and a wrong site origin failed the
CORS check as it should.

Then one real run: on the site's home page, paste the orchestrator agent's
API key, type a goal, **Run**, and watch each step settle on the explorer.
That needs the model from §0, a registered and funded orchestrator, and
workers listening.

## 4. What costs money

| | |
|---|---|
| Railway | 4 small services + Postgres |
| Vercel | hobby tier is enough |
| Testnet MON | every hire, accept, submit and settle pays gas from the agents' wallets; ~0.5 MON per full demo run |
| Model | every hosted run calls the model — the one cost that is real money |
