# Security

## Status

AGENTX runs on **Monad testnet only**, with test tokens. Neither the backend nor
the contracts have had an external audit. What has been done instead is listed
here; none of it replaces an audit.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting
on this repository ("Security" tab → "Report a vulnerability") with the
component, the request or call that triggers it, and a reproduction if you have
one. Testnet deployments hold no real value, so there is no bounty; credit is
given in the fix commit.

## How the backend is built to fail safe

| Property | Where |
|---|---|
| **Only the signer holds a key.** The API encodes a transaction and hands it over private networking; a compromised API can propose, never sign. | `apps/signer`, `apps/api/src/submit.ts` |
| **The signer is not public.** Without `SIGNER_TOKEN` it binds to loopback and refuses to listen wider; with one, every request must present it (constant-time compare). | `apps/signer/src/auth.ts` |
| **Spending caps hold even if the signer is compromised**, for every demo agent: they live in the agent's `AgentAccount` on chain. For a plain-EOA agent the signer enforces them off-chain (atomic reserve under a per-agent lock). | `agentx-contracts/src/AgentAccount.sol`, `apps/signer/src/signer.ts` |
| **API keys:** `ax_<keyId>_<secret>`, 192 random bits; only a SHA-256 of the key is stored; one indexed lookup per request (no work amplification); shown once. | `apps/api/src/auth.ts` |
| **Rate limited per client IP before authentication**, so garbage keys cannot buy fresh buckets. | `apps/api/src/app.ts` |
| **Unguessable public ids** for jobs and runs; a serial id names nothing (404). | migration `0005` |
| **Every input validated** with zod — API bodies and queries, the signer's `/sign`, the environment at boot. RFC 7807 errors; a 500 never returns an internal message. | `apps/*/src` |
| **Secrets:** `.env` only; redacted from every log line (`authorization`, `x-payment`, key material); a pre-commit hook and CI scan tracked files; gitleaks scans the full history. | `scripts/check-no-secrets.mjs`, `packages/service/src/http.ts` |
| **Agent output is untrusted data**, never instructions: results are shape-checked before any model sees them and passed to models inside a delimited, instruction-free wrapper. | `packages/agent-core` (docs/04 §7.3) |
| **Supply chain:** frozen lockfile; `pnpm audit --prod` at high in CI; CodeQL; Dependabot. | `.github/` |
| **Containers** run as an unprivileged user with production dependencies only and no `.env`. | `Dockerfile` |

The full threat model is `docs/04-how-it-works.md` §9.

## Known limits

- One arbiter key decides disputes (the deployer's, on testnet); a dispute
  nobody rules on expires in the worker's favour after `disputeTimeoutSeconds`.
- Rate limiting and the SSE bus are per process. With more than one API
  replica the effective limit is N× the configured one; idempotency is
  unaffected (a UNIQUE constraint in Postgres).
- The signer's raw-key mode is for testnet only and refuses any other chain;
  production uses an encrypted keystore.
