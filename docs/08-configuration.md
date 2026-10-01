# 08 — Configuration Architecture

**Decision (2026-09-22):** ship on **Monad testnet (10143) first**, with
**mainnet (143) supported by the same code from day one**. The network is
configuration, never a code path.

This document is the single-source-of-truth design. It exists because
"support two networks" is where projects quietly grow a second copy of every
constant.

---

## 1. The rule

> **Every fact is declared in exactly one place. Everything else derives from
> it.**

A fact typed twice is a fact that will disagree with itself. The whole design
below is the mechanical application of that one rule.

Four config domains, four owners, no overlap:

| Domain | Single source | Format | Who writes it |
|---|---|---|---|
| **Network facts** | `config/networks.json` | JSON, EIP-3085 shaped | human, rarely |
| **Protocol parameters** | `config/params.<chainId>.json` | JSON | human, per network |
| **Deployed addresses** | `deployments/<chainId>.json` | JSON | **generated** by the deploy script |
| **Secrets & runtime** | environment variables | env | ops, per environment |

And the rule that keeps them apart:

> **Secrets go in env. Everything else goes in versioned config.**

An RPC URL is not a secret. A chain ID is not a secret. A contract address is
not a secret. Putting them in env vars is how you end up with a staging
deployment pointing at mainnet.

---

## 2. Network registry — `config/networks.json`

Lives in `agentx-contracts`, published inside `@agentx/contracts`. Keyed by
chain ID, because chain ID is the only identifier that cannot be ambiguous.

The value shape deliberately matches **EIP-3085** (`wallet_addEthereumChain`)
and the [ethereum-lists/chains](https://github.com/ethereum-lists/chains)
convention, so the same object can be handed straight to a wallet, to viem's
`defineChain`, and to Foundry — without a translation layer.

```json
{
  "10143": {
    "chainId": 10143,
    "name": "Monad Testnet",
    "shortName": "monad-testnet",
    "foundryAlias": "monad_testnet",
    "testnet": true,
    "nativeCurrency": { "name": "MON", "symbol": "MON", "decimals": 18 },
    "rpcUrls": ["https://testnet-rpc.monad.xyz"],
    "blockExplorerUrls": ["https://testnet.monadexplorer.com"],
    "faucetUrls": ["https://faucet.monad.xyz"],
    "confirmations": 2,
    "paymentToken": {
      "symbol": "MockUSDC",
      "decimals": 6,
      "address": null,
      "deployWithProtocol": true
    },
    "erc8004": {
      "deployWithProtocol": true,
      "identityRegistry": null,
      "reputationRegistry": null,
      "note": "Verified 2026-09-22: ERC-8004 is NOT deployed on Monad testnet. We deploy the reference implementation ourselves."
    }
  },

  "143": {
    "chainId": 143,
    "name": "Monad",
    "shortName": "monad",
    "foundryAlias": "monad",
    "testnet": false,
    "nativeCurrency": { "name": "MON", "symbol": "MON", "decimals": 18 },
    "rpcUrls": [
      "https://rpc.monad.xyz",
      "https://rpc1.monad.xyz",
      "https://rpc2.monad.xyz"
    ],
    "blockExplorerUrls": ["https://monadscan.com", "https://monadvision.com"],
    "faucetUrls": [],
    "confirmations": 5,
    "paymentToken": {
      "symbol": "USDC",
      "decimals": 6,
      "address": null,
      "deployWithProtocol": false,
      "note": "D8: fill from the Monad token list before any mainnet deploy."
    },
    "erc8004": {
      "deployWithProtocol": false,
      "identityRegistry": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
      "reputationRegistry": "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
      "identityImplementationPinned": "0x7274e874ca62410a93bd8bf61c69d8045e399c02"
    }
  }
}
```

`deployWithProtocol` is the field doing the real work, and it appears twice
for the same reason:

- **`paymentToken`** — testnet deploys `MockUSDC` and writes the address back
  into `deployments/10143.json`; mainnet refuses to deploy a token and asserts
  the configured address has ERC-20 code at it.
- **`erc8004`** — testnet deploys the reference registries, because
  [ERC-8004 is not on Monad testnet](09-landscape.md#8-m1-00-verification--results-2026-09-22-on-chain);
  mainnet uses the canonical `0x8004…` addresses.

Same script, no branches in application code. `identityImplementationPinned`
records the ERC-1967 implementation seen at integration time so CI can detect
an upgrade under us.

`confirmations` differs by network on purpose — 2 on a testnet you can re-run,
5 on a mainnet you cannot.

---

## 3. Protocol parameters — `config/params.<chainId>.json`

The parameter table in [04 §2.5](04-how-it-works.md#25-parameters) is
**documentation generated from these files**, not a second copy of them.

```jsonc
// config/params.10143.json — testnet: tuned so the demo shows both paths
{
  "minStake":             "10000000",   // 10 USDC
  "withdrawDelaySeconds": 604800,       // 7 days
  "fastPathMax":          "30000",      // 0.03 USDC
  "fastPathMinScore":     70,
  "protocolFeeBps":       100,          // 1%
  "acceptWindowSeconds":  300,          // 5 min
  "workWindowSeconds":    1800,         // 30 min
  "reviewWindowSeconds":  600,          // 10 min
  "confidenceFloor":      25,
  "defaultPerTaskCap":    "100000",     // 0.10 USDC, a new agent's spend_policies row
  "defaultDailyCap":      "1000000"     // 1.00 USDC
}
```

```jsonc
// config/params.143.json — mainnet: more conservative everywhere
{
  "minStake":             "100000000",  // 100 USDC
  "withdrawDelaySeconds": 1209600,      // 14 days
  "fastPathMax":          "500000",     // 0.50 USDC
  "fastPathMinScore":     80,
  "protocolFeeBps":       100,
  "acceptWindowSeconds":  900,
  "workWindowSeconds":    3600,
  "reviewWindowSeconds":  3600,         // an hour to dispute, not ten minutes
  "confidenceFloor":      50,
  "defaultPerTaskCap":    "50000",      // 0.05 USDC
  "defaultDailyCap":      "250000"      // 0.25 USDC
}
```

These files are read by the deploy script and the backend, and the interface
sees them through the API:

```
config/params.<chainId>.json
   │
   ├─▶ Deploy.s.sol         vm.parseJsonUint(...)   sets them on-chain
   ├─▶ @agentx/config       zod-validated           API (fast-path rule incl.
   │                                                fastPathMinScore, windows,
   │                                                default caps), indexer
   │                                                (confidenceFloor)
   └─▶ agentx-interface     via GET /v1/network     UI shows the real thresholds
```

The backend and the contract use the same numbers because they read the same
bytes — as long as the deployment has not been changed since. That is what
the drift check is for.

**Drift check:** `make drift NETWORK=monad_testnet` in `agentx-contracts`
(`scripts/check-param-drift.mjs`, added 2026-09-29) reads `TaskEscrow.config()`
and `StakeVault`'s `minStake` / `withdrawDelay` from the chain, maps them the
way `Deploy.s.sol` does, and exits 1 on any difference. It is run by hand; CI
does not run it, since CI has no deployed chain to read. Against Monad testnet
on 2026-09-29 it reported no drift. A config file that disagrees with the
chain is worse than no config file.

---

## 4. Deployments — `deployments/<chainId>.json`

**Generated. Never hand-edited.** The deploy script writes it from the Foundry
broadcast artifact.

```json
{
  "chainId": 10143,
  "deployedAt": "2026-09-28T14:02:11Z",
  "deployer": "0x...",
  "commit": "a1b2c3d",
  "startBlock": 48120,
  "contracts": {
    "TaskEscrow":          "0x...",
    "StakeVault":          "0x...",
    "AgentAccountFactory": "0x...",
    "PaymentToken":        "0x..."
  },
  "erc8004": {
    "identityRegistry":    "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    "reputationRegistry":  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"
  }
}
```

`erc8004` holds the **resolved** registry addresses for this chain — the
canonical ones on mainnet, our own deployment on testnet (where ERC-8004 is
absent). Same key name as in `networks.json`, so there is one word for one
concept. Nothing in the codebase hardcodes these.

- `startBlock` is why the indexer never scans from genesis.
- `commit` is how you answer "which source is actually deployed?" six days
  later at 2am.

### Addresses differ per network (plain `CREATE`)

**As built, `Deploy.s.sol` deploys with plain `new` — `CREATE`, not
`CREATE2`.** Each address depends on the deployer's nonce, so testnet and
mainnet addresses will differ, and a redeploy on the same network gives new
addresses. Only `AgentAccount` clones, made by `AgentAccountFactory`, are at
CREATE2-predictable addresses.

The original intent was deterministic deployment through the standard
deterministic-deployment proxy (`0x4e59b44847b379578588920cA78FbF26c0B4956C`)
with a fixed salt, for identical addresses on both networks. That is why the
contracts take only an `admin` in the constructor and receive every parameter
through a post-deploy `configure()` call driven by `params.<chainId>.json`.
That shape is kept, but nothing uses a salt today.

Nothing breaks either way, because **no code ever hardcodes an address** — it
looks them up by chain ID in `deployments/<chainId>.json`.

---

## 5. Environment variables — secrets and wiring only

The complete list. If something is not here, it belongs in versioned config.

```bash
# which networks this process serves
ENABLED_CHAIN_IDS=10143            # comma-separated; "10143,143" runs both
DEFAULT_CHAIN_ID=10143             # used when a request omits chainId

# optional per-chain RPC override (private/paid endpoint, higher rate limit)
RPC_URL_10143=
RPC_URL_143=

# secrets
DATABASE_URL=
SIGNER_KEYSTORE_JSON=              # KMS is not built
SIGNER_KEYSTORE_PASSPHRASE=
SIGNER_DEV_PRIVATE_KEY=            # local only; never set in production
SIGNER_TOKEN=                      # shared secret, set in BOTH api and signer;
                                   # unset → signer binds 127.0.0.1 only
KEEPER_PRIVATE_KEY=                # the keeper's OWN key (gas only), never one the
                                   # signer uses; testnet only; unset → no keeper

# model providers — at least one, or every agent run falls back to a recording
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=

# which brain, and whether tokens are spent at all
AGENT_MODE=cached                  # cached | record | live
AGENT_CACHE_DIR=
BRAIN_CHAIN=gemini,groq,ollama,claude
BRAIN_CHAIN_ORCHESTRATOR=claude,gemini,groq,ollama
CLAUDE_MODEL=
CLAUDE_WORKER_MODEL=
GEMINI_MODEL=
GROQ_MODEL=
OLLAMA_HOST=
OLLAMA_MODEL=

# acting AS an agent — a worker or the orchestrator cannot start without these
AGENTX_API_URL=http://127.0.0.1:8080
AGENTX_API_KEY=
AGENTX_CHAIN_ID=10143
AGENTX_SELF_URL=                   # the API's own address, for in-process runs

# wiring
AGENTX_CONTRACTS_ROOT=../agentx-contracts
PORT=8080
SIGNER_PORT=7070
SIGNER_HOST=                       # bind address; anything but loopback needs SIGNER_TOKEN
SIGNER_URL=http://127.0.0.1:7070
KEEPER_INTERVAL_MS=15000           # how often the keeper sweeps
LOG_LEVEL=info
INDEXER_POLL_MS=2000
INDEXER_MAX_BACKOFF_MS=60000
INDEXER_HEALTH_PORT=               # indexer: serve /health /ready /metrics here; unset → none

# api
NODE_ENV=development               # production → CORS_ORIGINS required, public-https endpoint URLs,
                                   # /metrics only behind METRICS_TOKEN
HOST=0.0.0.0                       # bind address (Railway: ::)
CORS_ORIGINS=                      # comma-separated browser origins; unset → any (dev only)
TRUST_PROXY=0                      # 1 behind Railway's proxy, so rate limits see the client IP
RATE_LIMIT_PER_MINUTE=600          # per client IP, per process
SSE_MAX_STREAMS=1000               # open SSE streams per kind, per process; then 503 + retry-after
SIGNER_TIMEOUT_MS=30000            # how long the api waits for the signer
STATUS_MAX_INDEXER_LAG_BLOCKS=150  # /v1/status: indexer "degraded" beyond this (+ confirmations)

# every service
METRICS_TOKEN=                     # bearer for /metrics; the api serves none in production without it
DB_POOL_MAX=                       # connection pool size (defaults: api 5, signer 5, indexer 3)
LOCK_POOL_MAX=10                   # signer: pool for per-agent nonce advisory locks
SIGNER_DEV_PRIVATE_KEYS=           # signer, testnet only: several agent keys, matched by wallet

# build metadata, reported on /health and /v1/status (docs/14 §3)
GIT_SHA=                           # baked into images at build; else read at runtime if a hex commit
BUILD_TIME=                        # ISO-8601; images record their own
# RAILWAY_GIT_COMMIT_SHA           — set by Railway; the image build uses it when GIT_SHA is not given

# workers (packages/agent-core)
WORKER_POLL_MS=1000                # how often a worker polls for jobs
AGENT_REPLAY_MAX_MS=               # cached mode: cap each replayed call's recorded delay
AGENTX_AGENT_ID=                   # the worker's own id; required with X402_PORT
X402_PORT=                         # serve an x402 pay-per-request endpoint on this port
X402_HOST=127.0.0.1
X402_PUBLIC_URL=                   # the URL clients are quoted; default http://127.0.0.1:<X402_PORT>
```

Scripts in `scripts/` read their own variables (`DEPLOYER_PRIVATE_KEY`,
`FUNDER_PRIVATE_KEY`, `AGENT_B_PRIVATE_KEY`, `VERIFY_CHAIN_ID`,
`CHECK_CHAIN_ID`, `DEMO_*`, `E2E_*`, `SLOW_RPC_*`); they are tools, not
services, and are documented where they are used.

> **Re-checked 2026-09-30** against every service's zod env schema
> (`apps/*/src/main.ts`) and every `process.env` / `env[...]` read in
> `apps/` and `packages/`. Seventeen names the services read were missing
> here: `NODE_ENV`, `HOST`, `CORS_ORIGINS`, `TRUST_PROXY`,
> `RATE_LIMIT_PER_MINUTE`, `SIGNER_TIMEOUT_MS`, `METRICS_TOKEN`,
> `DB_POOL_MAX`, `LOCK_POOL_MAX`, `INDEXER_HEALTH_PORT`,
> `SIGNER_DEV_PRIVATE_KEYS`, `AGENT_REPLAY_MAX_MS`, `AGENTX_AGENT_ID`,
> `WORKER_POLL_MS`, `X402_HOST`, `X402_PORT`, `X402_PUBLIC_URL`.
> `STATUS_MAX_INDEXER_LAG_BLOCKS`, `GIT_SHA` and `BUILD_TIME` are new.

> **Corrected 2026-09-28.** The list above claimed to be complete while
> omitting sixteen variables, including the three a worker needs to start at
> all. Two entries were removed instead: `REDIS_URL`, because nothing in the
> codebase imports a Redis client, and `API_JWT_SECRET`, because
> authentication is hashed API keys (scrypt then; SHA-256 since 2026-09-30) and there is no JWT anywhere —
> config that implies a mechanism which does not exist is worse than absent.
> `EXPLORER_API_KEY` belongs to `agentx-contracts/.env`, not this one.
>
> **Added 2026-09-29:** `SIGNER_TOKEN`, `SIGNER_HOST`, `KEEPER_PRIVATE_KEY` and
> `KEEPER_INTERVAL_MS`. `SIGNER_HOST` is read by the signer but not listed in
> `.env.example`. In `agentx-contracts/.env`, `ARBITER_ADDRESS` and
> `FEE_RECIPIENT` are now read by `Deploy.s.sol` (empty means the deployer);
> before that date nothing read them.

Three properties worth noting:

0. **There is no Redis.** Rate limiting is therefore per-process: with one
   replica that is correct, with N replicas the effective limit is N times the
   configured one. Idempotency is unaffected — it is a `UNIQUE` constraint in
   Postgres, not an in-memory set.
1. **`ENABLED_CHAIN_IDS` is a list, not a switch.** One backend serves both
   networks at once. Running testnet and mainnet is a config value, not a
   second deployment.
2. **`RPC_URL_<chainId>` is an override, not a requirement.** Absent, the
   registry default is used. The naming embeds the chain ID so it is
   impossible to point the mainnet client at a testnet RPC by editing the
   wrong line.
3. **No contract address is ever an env var.** They come from
   `deployments/<chainId>.json`. This is the single most common source of
   "works locally, points at the wrong contract in production".

---

## 6. `@agentx/config` — the one import

```ts
import { loadConfig } from '@agentx/config'

const config = loadConfig()          // validates, freezes, throws on bad input

config.defaultChainId                // 10143
config.chains[10143].name            // "Monad Testnet"
config.chains[10143].contracts.TaskEscrow
config.chains[10143].params.fastPathMax      // 30000n
config.chains[10143].viemChain               // ready for createPublicClient
config.chains[10143].explorerTx('0xab…')     // full URL
config.chains[10143].formatToken(20000n)     // "0.02 USDC"
```

Assembled from `networks.json` + `params.<id>.json` + `deployments/<id>.json`,
validated with zod, and **frozen**. Mutating config at runtime is how two
services end up disagreeing.

### Fail fast, and say why

```
✗ AGENTX config invalid

  ENABLED_CHAIN_IDS=10143,143
  └─ chain 143: deployments/143.json not found
     → run `make deploy NETWORK=monad` first,
       or drop 143 from ENABLED_CHAIN_IDS

  chain 10143: params.fastPathMax (30000) > params.minStake (10000000)? ok
  chain 143:   paymentToken.address is a placeholder
     → fill it from the Monad token list
```

A service that boots with broken config and fails on the first user request is
strictly worse than one that refuses to boot. Validate everything at startup,
print every problem at once, exit non-zero.

### Helpers that stop bugs, not just save typing

| Helper | Prevents |
|---|---|
| `formatToken` / `parseToken` | 6-vs-18 decimal mistakes |
| `explorerTx` / `explorerAddress` | hand-built URLs that 404 on one network |
| `viemChain` | a hand-rolled chain object drifting from the registry |
| `assertSameChain(a, b)` | cross-chain data joined by accident |

---

## 7. Foundry side — the standard multi-network setup

```toml
# foundry.toml
[profile.default]
solc_version = "0.8.26"
optimizer = true
optimizer_runs = 200
fs_permissions = [{ access = "read-write", path = "./deployments" },
                  { access = "read",       path = "./config" }]

[rpc_endpoints]
monad_testnet = "${RPC_URL_10143}"
monad         = "${RPC_URL_143}"

[etherscan]
monad_testnet = { key = "${EXPLORER_API_KEY}", chain = 10143 }
monad         = { key = "${EXPLORER_API_KEY}", chain = 143 }
```

`Deploy.s.sol` reads its own parameters — the script is network-agnostic:

```solidity
function run() external {
    uint256 chainId = block.chainid;
    string memory p = vm.readFile(
        string.concat("config/params.", vm.toString(chainId), ".json")
    );

    Params memory params = Params({
        minStake:       uint96(vm.parseJsonUint(p, ".minStake")),
        fastPathMax:    uint128(vm.parseJsonUint(p, ".fastPathMax")),
        protocolFeeBps: uint16(vm.parseJsonUint(p, ".protocolFeeBps")),
        // …
    });
    // deploy with plain `new` (CREATE), then configure(params);
    // FEE_RECIPIENT / ARBITER_ADDRESS from env, defaulting to the deployer
    // (then `make deploy` runs write-deployment.mjs → deployments/<chainId>.json)
}
```

One command, network chosen by alias:

```makefile
NETWORK ?= monad_testnet

deploy:                            # VERIFY=1 adds --verify
	forge script script/Deploy.s.sol:Deploy --rpc-url $(NETWORK) --broadcast $(VERIFY_FLAG) -vvv
	node scripts/write-deployment.mjs $(NETWORK)

deploy-mainnet:
	@echo "Deploying to MAINNET. Type the chain id to confirm:"
	@read -r c; [ "$$c" = "143" ] || (echo "aborted"; exit 1)
	$(MAKE) deploy NETWORK=monad
```

The mainnet confirmation prompt is not paranoia. `make deploy` with a wrong
`NETWORK` is a single character away from a real-money mistake.

---

## 8. Multi-chain data model

Supporting two networks changes the database. The original schema in
[04 §4](04-how-it-works.md#4-database-schema) assumed one chain and is
**corrected there**; the reasoning is here.

Agent `#42` exists on testnet *and* on mainnet, and they are different agents
with different reputations. So:

```sql
-- chain_id on every chain-derived table
ALTER TABLE agents ADD COLUMN chain_id BIGINT NOT NULL;

-- uniqueness is per-chain, never global
-- WRONG: chain_agent_id  NUMERIC(78,0) UNIQUE
-- RIGHT:
CREATE UNIQUE INDEX ON agents (chain_id, chain_agent_id);
CREATE UNIQUE INDEX ON agents (chain_id, wallet_address);
CREATE UNIQUE INDEX ON jobs   (chain_id, chain_job_id);

-- the indexer runs one cursor per (chain, contract)
-- WRONG: PRIMARY KEY (contract)
-- RIGHT:
PRIMARY KEY (chain_id, contract)
```

Rules that follow, and each one is a bug you would otherwise ship:

| Rule | Why |
|---|---|
| Reputation is **per chain** | Testnet history must never inflate a mainnet score. Free testnet MON would make reputation purchasable. |
| A job's client and worker must be **on the same chain** | DB CHECK plus an API guard |
| Discovery **always filters by `chain_id`** | Otherwise the marketplace silently mixes networks |
| The API takes `?chainId=`, defaulting to `DEFAULT_CHAIN_ID` | Explicit beats implicit at the boundary |
| Every response **echoes `chainId`** | A client should never have to guess which network a result came from |
| The UI shows a network badge, always | A testnet transaction that looks like mainnet is a support ticket |

---

## 9. Reusable packages

The split that makes the above possible rather than aspirational.

```
@agentx/config      networks + params + deployments, validated & frozen
                    → depends on: @agentx/contracts
@agentx/contracts   ABIs, addresses, typed viem bindings   (generated)
@agentx/shared      JobSpec / JobResult / error codes      (zod, single source)
@agentx/sdk         typed API client used by agents and web
```

Dependency direction is strictly one-way — `contracts → config → shared → sdk`
— so nothing can form a cycle.

| Rule | Consequence |
|---|---|
| Types are **derived from zod schemas**, never hand-written alongside them | Validation and types cannot disagree |
| ABIs are **generated** from Foundry artifacts | A changed signature is a compile error, not a runtime revert |
| Error codes are an **enum in `@agentx/shared`** | API, agents and UI branch on the same constants |
| No package imports from an app | Apps compose packages; packages never know about apps |

---

## 10. Standards this follows

Nothing invented. Every choice below is the documented default somewhere.

| Concern | Standard |
|---|---|
| Config vs secrets separation | [12-Factor App §3](https://12factor.net/config) |
| Network descriptor shape | [EIP-3085](https://eips.ethereum.org/EIPS/eip-3085), ethereum-lists/chains |
| Deterministic deployment | CREATE2 via the deterministic-deployment proxy — the intent; **not done**: `Deploy.s.sol` uses plain CREATE (§4). Only `AgentAccount` clones are CREATE2 |
| Contract libraries | OpenZeppelin Contracts 5.x |
| Solidity layout & NatSpec | Official Solidity style guide, `forge fmt` |
| Multi-network Foundry | `[rpc_endpoints]` + `[etherscan]` aliases |
| Runtime validation | zod schemas, validated at process start |
| Versioning | Semver; ABI change ⇒ minor pre-1.0, major after |
| Commits | Conventional Commits |
| Errors over HTTP | RFC 7807 problem details |
| Money | integer base units, `NUMERIC(38,0)`, never floats |

---

## 11. Checklist: adding a third network

The test of whether this design actually works. Adding a network should be
configuration and a deploy — no application code.

1. Add its entry to `config/networks.json`
2. Add `config/params.<chainId>.json`
3. `make deploy NETWORK=<alias>` → writes `deployments/<chainId>.json`
4. `make export` (the backend reads the contracts checkout via
   `AGENTX_CONTRACTS_ROOT`; `@agentx/contracts` is not published), and
   `make drift NETWORK=<alias>` to confirm the chain matches the params file
5. Add the chain ID to `ENABLED_CHAIN_IDS`

**Zero** application code changes. If a step 6 appears that touches `apps/`,
something above has leaked and should be fixed rather than worked around.
