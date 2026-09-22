# agentx-backend

Backend services for **AGENTX** — proof-of-payment reputation and escrow for
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agents on Monad.

Contracts live in
[`agentx-contracts`](https://github.com/gopaltalaviya/agentx-contracts);
the UI lives in
[`agentx-interface`](https://github.com/gopaltalaviya/agentx-interface).
They are separate repositories so that Foundry sources and deploy keys never
enter a Railway or Vercel build container.

## Packages

| Package | Role |
|---|---|
| `@agentx/config` | The **one** import for chain facts, protocol parameters and contract addresses. Validated with zod and frozen at boot. |
| `@agentx/shared` | `JobSpec`, `JobResult`, error codes — zod schemas with types derived from them, so validation and types cannot drift. |

## Apps (in progress)

`api` (Fastify REST + SSE) · `indexer` (chain → Postgres) · `signer`
(policy-checked signing) · `mcp` (agent-facing tools) · `agents`
(orchestrator + workers).

## Quickstart

```bash
pnpm install
docker compose up -d          # Postgres 16 + Redis 7
pnpm -r build
pnpm test

# Requires a deployment to exist in the contracts checkout
AGENTX_CONTRACTS_ROOT=../agentx-contracts \
ENABLED_CHAIN_IDS=31337 node packages/config/bin/check.mjs
```

## Configuration

**Secrets go in env. Everything else is versioned config** in the contracts
repo. No contract address is ever an environment variable — that is the most
common cause of "works locally, points at the wrong contract in production".

One backend serves every chain in `ENABLED_CHAIN_IDS` at once; running testnet
and mainnet together is a config value, not a second deployment.

Config is validated at startup and reports **every** problem at once with an
actionable fix:

```
✗ AGENTX config invalid
  • chain 10143: deployments/10143.json not found
    → run `make deploy NETWORK=monad_testnet`, or drop 10143 from ENABLED_CHAIN_IDS
```

A service that boots with broken config and fails on the first user request is
strictly worse than one that refuses to boot.

## Money

Token amounts cross every boundary as **decimal strings of integer base
units**, never JSON numbers — a `uint128` amount exceeds 2^53, so a JSON number
would lose precision silently and the first symptom would be a payment that
fails to reconcile.

## License

MIT
