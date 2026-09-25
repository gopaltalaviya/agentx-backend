# 07 — What I Need From You

Grouped by when it blocks me. Nothing here takes more than a few minutes each;
the ones marked **BLOCKING** stop work entirely until they exist.

Mark items done in [PROGRESS.md](../PROGRESS.md) as you complete them.

---

## A. Before I can write any code — **BLOCKING**, needed 2026-09-22/23

### A1. Three empty GitHub repos

Create them yourself — I do not create repos or remotes.

| Repo | Visibility |
|---|---|
| `agentx-contracts` | **private** |
| `agentx-backend` | private (public later if you want) |
| `agentx-interface` | private (public later if you want) |

Give me: the three URLs, and your GitHub username/org for the package scope.

### A2. Monad chain facts — ✅ mostly done

Verified 2026-09-22 by web lookup; recorded in
[PROGRESS.md → Facts & Config](../PROGRESS.md#-facts--config).

- ✅ Testnet chain ID **10143**, RPC `https://testnet-rpc.monad.xyz`,
  explorer `https://testnet.monadexplorer.com`, faucet `https://faucet.monad.xyz`
- ✅ Mainnet chain ID **143**, RPC `https://rpc.monad.xyz`,
  explorers `monadvision.com` / `monadscan.com`

Still yours to check:

- [ ] Faucet per-day limit
- [ ] Does `forge verify-contract` need an API key or a custom verifier URL?
- [ ] Canonical/bridged USDC address on whichever network we target (if none on
      testnet, we use `MockUSDC` and say so in the submission)

### A2b. 🔴 Testnet or mainnet? — **the one that actually matters**

`hackathon.monad.xyz` renders **"MonadChain (ID: 143)"** — that is mainnet.
Every plan document assumes testnet.

Confirm with the organisers or the rules page. If mainnet is required:

- `MockUSDC` is out; we use real USDC, and every demo transaction costs money
- gas is real MON, with no faucet
- the `AgentAccount` spending caps stop being a design flourish and become the
  thing between a runaway agent loop and a drained wallet
- the contracts have to be right the first time

The architecture does not change either way — only the deploy target, the
token address, and how carefully we fund things. But I need the answer before
**Sep 28** (M1-19).

### A3. Four funded testnet wallets

Create fresh wallets, fund each from the faucet, and tell me **only the
addresses** — never the private keys.

| Wallet | Purpose |
|---|---|
| `DEPLOYER` | deploys contracts, holds admin role |
| `FUNDER` | tops up agent wallets with MON for gas |
| `AGENT_A` | orchestrator / client agent |
| `AGENT_B` | worker agent |

Fund all four on day one. Faucets rate-limit, and discovering that on Oct 12
is how hackathon runs end.

### A4. Deadline — ✅ verified 2026-09-22

- Submission deadline **2026-10-13, 11:59 PM ET** (Oct 14, 03:59 UTC)
- Judging Oct 14–27, winners announced Nov 3
- Rolling submissions from Sep 1; editable until the deadline; late submissions
  not accepted
- Requirement: *"a working product with a public project profile: a demo, a
  short write-up, and a link to the code"* → **the repos must be public by
  Oct 13**, which resolves D2
- Target track: **4 — Trust, Identity & AI Infrastructure** ($30,000). Its
  description explicitly names "agent trust" and "agent reputation systems"

Still worth you confirming from inside the logged-in portal: video length
limit and the exact required submission fields.

---

## B. Needed by 2026-09-26 — before the backend starts

### B1. Anthropic API key

For the agents' LLM calls. A key with a spend limit set on it; the agents are
autonomous and I would rather the cap be real.

Put it in Railway env vars yourself as `ANTHROPIC_API_KEY`. For local dev I
need one too — use a separate key with a low cap so it can be rotated without
touching production.

### B2. Railway account + project

- [ ] Railway account, new project `agentx`
- [ ] Postgres plugin added
- [ ] Redis plugin added
- [ ] `agentx-backend` connected
- [ ] Railway token, if you want me to configure services via CLI (optional —
      you can click through the dashboard instead)

### B3. Vercel account

- [ ] Vercel account, `agentx-interface` connected
- [ ] Root directory set to the repo root (not a subfolder — that is the whole
      point of the split)

---

## C. Needed by 2026-10-01 — before signing goes live

### C1. Key storage decision

Where the agent session keys live. Standard approach is AWS KMS, but it is an
AWS account and an afternoon of IAM.

Options, in order of my recommendation for a 21-day project:

1. **Railway env var holding an encrypted keystore**, decrypted in the signer
   process with a passphrase in a separate env var. Not ideal, honest, fine for
   testnet, documented as a limitation.
2. **AWS KMS.** Correct, and what I specced. Needs an AWS account, a KMS key,
   and an IAM user for the signer.

Tell me which. If AWS: account access or the created `KMS_KEY_ID` + IAM
credentials placed in Railway by you.

### C2. Arbiter address

The multisig or address that resolves disputes. A plain EOA is acceptable for
the MVP as long as we say so in the docs. Give me the address.

### C3. Fee recipient address

Where protocol fees accrue. Can be the same as `DEPLOYER` for the demo.

---

## D. Things you run, at each milestone

I write the scripts; you run them because you hold the keys.

| When | Command | You give me back |
|---|---|---|
| Sep 24 | `make deploy-local` | confirmation it worked |
| Sep 28 | `make deploy-testnet` | the 5 contract addresses + deploy block number |
| Sep 28 | `make publish` | the published `@agentx/contracts` version |
| Oct 2 | `./scripts/e2e.sh` | pass/fail + the output if it fails |
| Oct 5 | `pnpm demo` | pass/fail + the explorer links |
| Oct 9 | chaos checklist ([roadmap §8](05-roadmap.md#8-m5--harden-and-rehearse--oct-911)) | which items broke |
| Oct 11 | 3 rehearsal runs + backup video | timing of each run |

---

## E. Decisions only you can make

Answer whenever, but before the milestone that needs them:

| # | Decision | Needed by | My recommendation |
|---|---|---|---|
| D1 | Package registry: GitHub Packages, or git-dependency fallback? | Sep 23 | Try GitHub Packages for 30 minutes; if it fights you, take the fallback ([06 §4](06-repo-structure.md#the-escape-hatch)) |
| D2 | Can `agentx-contracts` be public at submission? | Oct 12 | Yes — verified source is already public on the explorer, and judges trust what they can read |
| D3 | Who pays the protocol fee, worker or client? | Sep 26 | Worker. It keeps quoted prices honest — the client pays exactly the listed price |
| D4 | Project name final? `AGENTX` — check it is not taken | Sep 25 | Search npm, GitHub, and the hackathon submissions list |
| D5 | Domain for the demo? | Oct 6 | Optional. A `*.vercel.app` URL is fine and judges do not care |

---

## F. Never send me

Stated plainly so there is no ambiguity later:

- ❌ Any private key or seed phrase, including testnet ones. You chose the
  "you run deploys" model — that only works if the key stays with you.
- ❌ AWS root credentials. A scoped IAM user only, and put it in Railway
  yourself.
- ❌ Your Anthropic key pasted into chat. Put it in Railway and local `.env`.
- ❌ Anything from a mainnet wallet, under any circumstances.

If I ever ask for one of these, that is a mistake on my part — do not send it.

---

## G. The short version

If you only do three things today:

1. Create the three repos, send me the URLs
2. Fund four wallets at `https://faucet.monad.xyz`, send me the **addresses**
3. 🔴 Answer **A2b** — testnet or mainnet?

That unblocks M0 and M1 — eight days of work.
