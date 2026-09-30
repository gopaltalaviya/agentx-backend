# Changelog

Notable changes. Dates are UTC. The full history, with evidence, is in
`PROGRESS.md` and the commit log.

## 2026-09-30 — Session 27
- Signer: an HTTP 5xx/429 from the RPC is a retryable outage, not
  `INVALID_STATE` — found by the 20%-lossy chaos run, where workers gave up
  an accept and a finished submit.
- Orchestrator: when a late accept makes the cancel fail, wait for the
  delivery and settle it, instead of abandoning it; still never re-hire.
- Indexer: job state only moves forward — a trailing indexer no longer
  overwrites the API's newer state with an older event (a delivered job read
  `accepted`, and approve was refused). Found by the M5-06 timed runs.
- Deploy: images build from this repo alone (`chain/`, drift-checked in CI);
  Railway configs in `deploy/railway/`; runbook `docs/13-deploy.md`;
  `scripts/check-deployment.mjs` checks a hosted API and site.
- M5-06: three consecutive clean timed demo runs — 149, 153, 168 s.
- `slow-rpc.mjs`: `SLOW_RPC_FAIL_SEND`, a separate failure rate for
  broadcasts. Verified live at 20% + 30% on broadcasts: 4/4 settled.

## 2026-09-30 — v2 contracts and production hardening (Session 26)

### Contracts (agentx-contracts, redeployed to Monad testnet)
- Reputation farming by self-dealing: hires between two agents of one owner
  are refused; a minimum job amount and fee floor put a cost on every review.
- Payments never trap funds: an undeliverable payout is held and claimable.
- `DISPUTED` has a timeout; the keeper expires it in the worker's favour.
- Parameter bounds, per-job captured windows, two-step delayed admin.
- `AgentAccount`: per-(target, selector) allowlist, native sweep, two-step
  ownership, checked downcast; the factory only lets an owner create theirs.

### Backend
- The signer's per-agent lock could stay held forever; it is now taken and
  released on one reserved connection.
- API keys: indexed lookup + SHA-256 (auth was an O(keys) scrypt
  denial-of-service lever); IP rate limiting before authentication.
- Jobs and runs have unguessable public ids.
- Validated environment at boot; graceful shutdown; `/ready`; Prometheus
  metrics; request ids; helmet; SSE stream cap; SSE headers sent at once
  (a quiet stream used to connect only at the first 25 s heartbeat).
- The signer names contract refusals (`SameOwner()`, …) and never returns an
  internal message; the API reports an unreachable signer as a retryable
  outage, not an empty wallet.
- The indexer no longer halts on an RPC blip as if for a reorg.
- drizzle-orm 0.45.3 (GHSA-gpj5-g38j-94v9).
- ESLint, Prettier, type-checked tests, coverage floors, Dockerfile and a
  full-stack compose, CI with CodeQL, gitleaks and audit.
- Demo and e2e scripts: each worker owns its identity (so it can be hired
  under `SameOwner`) and its AGENTX record names that owner; `keeper-sweep`
  reports an expired dispute as the settlement it is.

### Interface (agentx-interface)
- Explorer links from the API pass an https + known-host allowlist (a
  `javascript:` URL used to reach an `href`); CSP and security headers; a
  production build without `NEXT_PUBLIC_API_URL` fails.
- uuid run ids validated server-side (real 404s); money shown as money;
  debounced, abortable marketplace filter; wallet inputs validated before
  the wallet is asked; one-time key with copy and leave-warning.
- Error, global-error and not-found boundaries; Open Graph metadata;
  labels, landmarks, focus ring, live regions.
- ESLint (jsx-a11y), Prettier, 40 unit tests, a Playwright smoke test of
  every page against a mocked API, audit clean (postcss override).

## 2026-09-30 — Session 25
- Worker `AgentAccount`s; the x402 facilitator and paid worker endpoints;
  the ERC-8183 mapping (docs/12).

## 2026-09-29 — Sessions 22–24
- First end-to-end runs on testnet; keeper; the orchestrator on an
  `AgentAccount`; chaos checklist complete; run history.
