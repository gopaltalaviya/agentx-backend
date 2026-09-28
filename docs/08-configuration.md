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
  "confidenceFloor":      25
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
  "confidenceFloor":      50
}
```

These files are read by **three** consumers, and that is the entire point:

```
config/params.<chainId>.json
   │
   ├─▶ Deploy.s.sol         vm.parseJsonUint(...)   sets them on-chain
   ├─▶ @agentx/config       zod-validated           backend pre-checks + API errors
   └─▶ agentx-interface           same package            UI shows the real thresholds
```

The backend's off-chain pre-check ([04 §3.2](04-how-it-works.md#32-signer-service))
and the contract's on-chain enforcement now provably use the same numbers,
because they read the same bytes.

**Drift test (CI):** read every parameter back from the deployed contracts and
assert it equals the JSON. A config file that disagrees with the chain is
worse than no config file, and this is a ten-line test.

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

### Deterministic addresses across networks

Deploy through the standard deterministic-deployment proxy
(`0x4e59b44847b379578588920cA78FbF26c0B4956C`, the Safe Singleton Factory
present on most EVM chains) with a fixed salt. Identical bytecode + identical
constructor args + identical salt ⇒ **identical addresses on testnet and
mainnet**.

That requires constructor args to be network-independent, which is why the
contracts take only an `admin` in the constructor and receive every parameter
through a post-deploy `configure()` call driven by `params.<chainId>.json`.
The parameters were always going to be settable — this just makes the
deployment deterministic for free.

Verify the proxy exists on Monad before relying on this; fall back to plain
`CREATE` and different-per-network addresses if it does not. Nothing breaks
either way, because **no code ever hardcodes an address** — it looks them up
by chain ID.

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
SIGNER_KEYSTORE_JSON=              # or KMS_KEY_ID
SIGNER_KEYSTORE_PASSPHRASE=
SIGNER_DEV_PRIVATE_KEY=            # local only; never set in production

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
SIGNER_URL=http://127.0.0.1:7070
LOG_LEVEL=info
INDEXER_POLL_MS=2000
INDEXER_MAX_BACKOFF_MS=60000
```

> **Corrected 2026-09-28.** The list above claimed to be complete while
> omitting sixteen variables, including the three a worker needs to start at
> all. Two entries were removed instead: `REDIS_URL`, because nothing in the
> codebase imports a Redis client, and `API_JWT_SECRET`, because
> authentication is scrypt-hashed API keys and there is no JWT anywhere —
> config that implies a mechanism which does not exist is worse than absent.
> `EXPLORER_API_KEY` belongs to `agentx-contracts/.env`, not this one.

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
    // deploy with CREATE2 + fixed salt, then configure(params)
    // then write deployments/<chainId>.json
}
```

One command, network chosen by alias:

```makefile
NETWORK ?= monad_testnet

deploy:
	forge script script/Deploy.s.sol --rpc-url $(NETWORK) --broadcast --verify
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
| Deterministic deployment | CREATE2 via the Safe Singleton Factory |
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
4. Publish `@agentx/contracts`
5. Add the chain ID to `ENABLED_CHAIN_IDS`

**Zero** application code changes. If a step 6 appears that touches `apps/`,
something above has leaked and should be fixed rather than worked around.
