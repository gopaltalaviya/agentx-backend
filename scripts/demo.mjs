#!/usr/bin/env node
/**
 * pnpm demo — the whole thing, unattended.
 *
 * Boots the stack, puts four agents on-chain, runs three workers, and hands
 * the orchestrator one sentence. Everything after that happens because agents
 * decided it should: what to commission, who to hire, whether the work was
 * worth paying for.
 *
 * It asserts on money and on the chain, never on log lines — the recurring
 * lesson of this project is that a mock which agrees with our assumptions
 * proves nothing.
 *
 *   VERIFY_CHAIN_ID=10143 pnpm demo
 *   AGENT_MODE=record pnpm demo     # spend once, replay free forever after
 *
 *   DEMO_VIA_API=1 pnpm demo        # run it through POST /v1/runs, as the interface does
 *   DEMO_CHAOS=no-accept pnpm demo  # a 4th worker that never accepts
 *   DEMO_CHAOS=mid-job pnpm demo    # a 4th worker that accepts, then dies
 *
 * Exit codes: 0 all assertions passed, 1 an assertion failed, 3 no brain is
 * reachable (nothing was spent and nothing was proven).
 */

import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createWriteStream, mkdirSync} from 'node:fs';
import {createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseEventLogs, toFunctionSelector} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import postgres from 'postgres';
import {z} from 'zod';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb, closeDb} from '@agentx/db';
import {AgentxClient} from '@agentx/sdk';
import {Orchestrator, Worker, buildBrain, describeBrain, confidence, serveX402} from '@agentx/agent-core';
import {Indexer} from '../apps/indexer/dist/indexer.js';

const CHAIN_ID = Number(process.env.VERIFY_CHAIN_ID ?? 31337);
const DB_URL = process.env.DATABASE_URL ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const API_PORT = Number(process.env.DEMO_API_PORT ?? 8098);
const SIGNER_PORT = Number(process.env.DEMO_SIGNER_PORT ?? 7098);
const GOAL =
  process.argv.slice(2).join(' ').trim() ||
  'Research ETH/USDC liquidity on Monad and tell me whether to open a position.';

let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
// Visible, but not a failure: an RPC blip mid-run is survivable, and burying
// it is how a run reports "the agents did not deliver" when the truth was
// that nothing was reading the chain.
const warn = (m) => console.error(`  ! ${m}`);
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failures++;
};

const config = loadConfig();
const abis = loadAbis();
const chain = config.chain(CHAIN_ID);
const sql = postgres(DB_URL, {max: 2, onnotice: () => {}});
const db = createDb(DB_URL);

const DEPLOYER = privateKeyToAccount(
  process.env.DEPLOYER_PRIVATE_KEY ??
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const viemChain = {...foundry, id: CHAIN_ID};
const pub = createPublicClient({chain: viemChain, transport: http(chain.rpcUrl)});
const wallet = createWalletClient({account: DEPLOYER, chain: viemChain, transport: http(chain.rpcUrl)});

const children = [];
const stopped = new AbortController();
const cleanup = async () => {
  stopped.abort();
  for (const c of children) c.kill();
  await sql.end().catch(() => {});
  await closeDb(db).catch(() => {});
};
process.on('exit', () => children.forEach((c) => c.kill()));

// ── the workers, as schemas ─────────────────────────────────────────────
// Deliberately duplicated from apps/agents/*: the demo runs them in-process so
// a failure shows up as a stack trace here rather than in a killed child.
const WORKERS = [
  {
    capability: 'market-research',
    price: '20000',
    role: 'a market research agent reporting on liquidity with concrete figures',
    output: z.object({
      summary: z.string().min(40).max(1_200),
      keyFindings: z.array(z.string().min(10)).min(1).max(5),
      confidence: confidence(),
    }),
  },
  {
    capability: 'trade-analysis',
    // Above fastPathMax (30000) ON PURPOSE, so this hire goes through escrow.
    // Every price used to sit at or below the threshold, so every demo job
    // took the fast path and the accept -> deliver -> judge -> approve route
    // — the one that writes reputation — was never exercised at all. The
    // params file's own comment always said the demo should cover both.
    price: '50000',
    role: 'a trading analysis agent that recommends a position with explicit risks',
    output: z.object({
      recommendation: z.enum(['buy', 'sell', 'hold']),
      rationale: z.string().min(40).max(1_000),
      confidence: confidence(),
      risks: z.array(z.string().min(10)).min(1).max(4),
    }),
  },
  {
    capability: 'trade-execution',
    price: '60000',
    role: 'an execution planning agent that produces an ordered plan with an abort condition',
    output: z.object({
      steps: z.array(z.object({action: z.string().min(5)})).min(1).max(6),
      preconditions: z.array(z.string().min(5)).min(1).max(5),
      abortIf: z.string().min(10),
    }),
  },
];

// ── chaos: a worker that is registered, bonded and cheap, and broken ────
// Priced under the real trade-analysis agent so a sensible selector picks it
// first. The run must still deliver: by cancelling an offer nobody accepted,
// or by giving up on an accepted job that never arrives and asking the other
// agent. The second leaves money in escrow until the work deadline, which the
// keeper refunds — `scripts/keeper-sweep.mjs` checks that after the fact.
const CHAOS = process.env.DEMO_CHAOS;
if (CHAOS && CHAOS !== 'no-accept' && CHAOS !== 'mid-job') {
  throw new Error(`DEMO_CHAOS must be no-accept or mid-job, not "${CHAOS}"`);
}
if (CHAOS) {
  WORKERS.push({...WORKERS[1], price: '40000', silent: CHAOS});
}

console.log(`\nAGENTX demo — ${chain.name} (${chain.chainId})`);
console.log(`  escrow   ${chain.contracts['TaskEscrow']}`);
console.log(`  mode     AGENT_MODE=${process.env.AGENT_MODE ?? 'cached'}`);

try {
  // ── 0. is there a brain at all? ───────────────────────────────────────
  // Checked before anything is deployed or spent. A demo that boots the whole
  // stack and then discovers it has no model has wasted a minute and told the
  // operator nothing useful.
  const orchestratorBrain = buildBrain({role: 'orchestrator'});
  console.log(`  brain    ${await describeBrain(orchestratorBrain)}\n`);

  if (!(await orchestratorBrain.available())) {
    // Before any chain write. Registering four identities and then failing
    // would spend gas to learn something we could have checked for free.
    console.error(
      '  No model is reachable, so nothing was deployed and nothing was spent.\n\n' +
        '  Pick one:\n' +
        '    GEMINI_API_KEY=...   free tier, no card (aistudio.google.com/apikey)\n' +
        '    GROQ_API_KEY=...     free tier\n' +
        '    ANTHROPIC_API_KEY=... paid\n\n' +
        '  Then record one run to replay it free from then on:\n' +
        '    AGENT_MODE=record pnpm demo\n',
    );
    await cleanup();
    process.exit(3);
  }

  // ── 1. identities and bonds ───────────────────────────────────────────
  const erc20 = parseAbi([
    'function mint(address,uint256)',
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ]);
  // Sign ONCE, then broadcast the same bytes until the node has them.
  //
  // viem does not retry `eth_sendRawTransaction`, rightly: re-running
  // `writeContract` after a dropped response signs a NEW transaction on a new
  // nonce, and if the first one had landed, the action happens twice. But the
  // same signed bytes are idempotent — same hash, same nonce — so resending
  // them is safe whatever happened to the first attempt. The slow-RPC chaos
  // run found this: one injected 503 on the harness's own setup transaction
  // aborted the demo, while every service behind it rode the same failures out.
  const send = async (client, request) => {
    const prepared = await client.prepareTransactionRequest(request);
    const raw = await client.signTransaction(prepared);
    const hash = keccak256(raw);
    for (let attempt = 0; ; attempt++) {
      try {
        await pub.sendRawTransaction({serializedTransaction: raw});
        break;
      } catch (err) {
        const msg = `${err.shortMessage ?? ''} ${err.details ?? ''} ${err.message ?? ''}`;
        // Already there: an earlier attempt reached the node after all.
        if (/already known|nonce too low|replacement transaction underpriced/i.test(msg)) break;
        const transient = err.name === 'HttpRequestError' || err.name === 'TimeoutError' || /50[234]|fetch failed|ECONNRESET/i.test(msg);
        if (!transient || attempt >= 5) throw err;
        await sleep(500 * 2 ** attempt);
      }
    }
    return pub.waitForTransactionReceipt({hash});
  };
  const write = (address, abi, fn, args) =>
    send(wallet, {to: address, data: encodeFunctionData({abi, functionName: fn, args})});

  const identity = chain.erc8004['identityRegistry'];
  const token = chain.contracts['PaymentToken'];
  const vault = chain.contracts['StakeVault'];
  const escrow = chain.contracts['TaskEscrow'];

  const firstId = await pub.readContract({
    address: identity,
    abi: abis['MockIdentityRegistry'],
    functionName: 'nextId',
  });

  await write(token, erc20, 'mint', [DEPLOYER.address, 1_000_000_000n]);
  await write(token, erc20, 'approve', [vault, 1_000_000_000n]);
  await write(token, erc20, 'approve', [escrow, 1_000_000_000n]);

  // The orchestrator, then one identity per worker.
  //
  // Each worker holds its OWN key, and the address it is registered to is the
  // address that key controls. That is not decoration: `TaskEscrow` resolves
  // a job's worker through the identity registry and requires `msg.sender` to
  // match, so an agent whose wallet nobody holds the key to can be hired and
  // paid, but can never accept a job or submit a result.
  //
  // These were `0x1111…`, `0x2222…`, `0x3333…` — addresses with no key
  // behind them at all. Every accept reverted with `NotAgentWallet`, which
  // viem reports as "execution reverted for an unknown reason", and the
  // escrow path had therefore never once completed.
  // ── the orchestrator spends through an AgentAccount ─────────────────
  // The claim this project rests on is that a hijacked agent cannot spend
  // past caps its owner set — enforced by a contract, not by our server.
  // Until now no agent used one. The orchestrator is the only agent that
  // spends, so it gets an account: the OWNER (the deployer, standing in for
  // a human) creates it, sets its caps and allowlists, funds it, grants the
  // escrow an allowance, and gives the signer's hot key a session key that
  // expires within a day. The hot key can then spend — but only through the
  // account, only to the escrow, only within the caps.
  const factory = chain.contracts['AgentAccountFactory'];
  const accountAbi = abis['AgentAccount'];
  // CREATE2 salts, unique per RUN, not per agent id. They were the next
  // ERC-8004 id alone — but a run that aborts after creating an account and
  // before registering an identity leaves that id unused, so the next run
  // derives the same salt and `createAccount` reverts on the address it
  // already occupies. The run's start time goes in the high bits.
  const runSalt = (n) => `0x${((BigInt(Date.now()) << 64n) | n).toString(16).padStart(64, '0')}`;
  const salt = runSalt(firstId);
  const orchestratorWallet = await pub.readContract({
    address: factory, abi: abis['AgentAccountFactory'], functionName: 'predictAddress', args: [DEPLOYER.address, salt],
  });
  const caps = {perTaskCap: BigInt(chain.params.defaultPerTaskCap), dailyCap: BigInt(chain.params.defaultDailyCap), allowlistOnly: true};
  await write(factory, abis['AgentAccountFactory'], 'createAccount', [DEPLOYER.address, salt, caps]);
  await write(orchestratorWallet, accountAbi, 'setAllowedTarget', [escrow, true]);
  for (const fn of ['createJob', 'directPay', 'approve', 'dispute', 'cancel']) {
    const item = abis['TaskEscrow'].find((x) => x.type === 'function' && x.name === fn);
    await write(orchestratorWallet, accountAbi, 'setAllowedSelector', [toFunctionSelector(item), true]);
  }
  await write(orchestratorWallet, accountAbi, 'setAllowance', [escrow, 1_000_000_000n]);
  await write(token, erc20, 'mint', [orchestratorWallet, 1_000_000n]); // 1 MockUSDC to spend
  const hotKey = `0x${'0a'.repeat(32)}`;
  const hot = privateKeyToAccount(hotKey);
  const block = await pub.getBlock({blockTag: 'latest'});
  await write(orchestratorWallet, accountAbi, 'grantSessionKey', [hot.address, block.timestamp + 23n * 3600n, caps.dailyCap]);
  ok(`orchestrator spends through AgentAccount ${orchestratorWallet} — caps ${chain.formatToken(caps.perTaskCap)}/task, ${chain.formatToken(caps.dailyCap)}/day, escrow-only, session key ${hot.address.slice(0, 10)}…`);

  await write(identity, abis['MockIdentityRegistry'], 'register', ['ipfs://orchestrator', orchestratorWallet]);

  const workerKeys = WORKERS.map(
    (_, i) => `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}`,
  );
  const workerAccounts = workerKeys.map((k) => privateKeyToAccount(k));

  // ── the workers act through AgentAccounts too ───────────────────────
  // A worker never spends, so its account is the narrowest one possible:
  // caps of zero, a session key with a budget of zero, and the escrow as the
  // only target with `acceptJob` and `submitResult` as the only selectors. A
  // stolen worker key can then accept and deliver work — which is all it
  // could ever legitimately do — and nothing else: it cannot move the
  // account's earnings, hire anyone, or grant itself an allowance.
  //
  // Each worker's OWN key is its session key. One shared hot key would race
  // for nonces: the signer locks per agent, but a nonce belongs to a key.
  //
  // Payouts land in the account, so the earnings are the owner's to sweep —
  // the account's kill switch, and the only way money leaves it.
  const workerCaps = {perTaskCap: 0n, dailyCap: 0n, allowlistOnly: true};
  const workerSelectors = ['acceptJob', 'submitResult'].map((fn) =>
    toFunctionSelector(abis['TaskEscrow'].find((x) => x.type === 'function' && x.name === fn)),
  );
  const workerWallets = [];
  for (const [i, key] of workerAccounts.entries()) {
    const workerSalt = runSalt(firstId + BigInt(i + 1));
    const account = await pub.readContract({
      address: factory, abi: abis['AgentAccountFactory'], functionName: 'predictAddress', args: [DEPLOYER.address, workerSalt],
    });
    await write(factory, abis['AgentAccountFactory'], 'createAccount', [DEPLOYER.address, workerSalt, workerCaps]);
    await write(account, accountAbi, 'setAllowedTarget', [escrow, true]);
    for (const selector of workerSelectors) {
      await write(account, accountAbi, 'setAllowedSelector', [selector, true]);
    }
    await write(account, accountAbi, 'grantSessionKey', [key.address, block.timestamp + 23n * 3600n, 0n]);
    workerWallets.push(account);
  }
  ok(`${WORKERS.length} workers act through AgentAccounts — zero caps, escrow-only, acceptJob + submitResult only, each on its own session key`);

  for (const [i, w] of WORKERS.entries()) {
    await write(identity, abis['MockIdentityRegistry'], 'register', [`ipfs://${w.capability}`, workerWallets[i]]);
    await write(vault, abis['StakeVault'], 'deposit', [firstId + BigInt(i + 1), 10_000_000n]);
  }

  // Gas for each worker. A worker that cannot pay for its own accept is a
  // worker that silently never accepts, and the signer's gas floor would
  // refuse before broadcasting — correctly, but the demo would just look
  // slow.
  // 0.5 MON. It was 0.02, which covered the fast path; then 0.1, when an
  // unproven worker was always hired through escrow — accept AND submit, two
  // transactions a job. Now every one of those is wrapped in
  // AgentAccount.execute, and Monad reserves the full gas LIMIT — about
  // 0.054 MON per wrapped call — so the workers need what the orchestrator's
  // session key needs. These wallets are the same every run, so this is paid
  // once, not per run.
  const GAS_TOPUP = 500_000_000_000_000_000n;
  // Gas comes from FUNDER, whose documented job this is, rather than
  // draining DEPLOYER, which pays for every registration and bond. This runs
  // before the signer starts, so it cannot race the keeper for FUNDER's
  // nonces.
  const gasPayer = process.env.FUNDER_PRIVATE_KEY
    ? createWalletClient({account: privateKeyToAccount(process.env.FUNDER_PRIVATE_KEY), chain: viemChain, transport: http(chain.rpcUrl)})
    : wallet;
  // The orchestrator's session key needs more: every call it makes goes
  // through AgentAccount.execute, and Monad reserves the full gas LIMIT —
  // about 0.054 MON per wrapped call — so 0.1 MON ran dry after two.
  const topups = [...workerAccounts.map((a) => [a, GAS_TOPUP]), [hot, GAS_TOPUP]];
  for (const [account, target] of topups) {
    const balance = await pub.getBalance({address: account.address});
    if (balance >= target) continue;
    await send(gasPayer, {to: account.address, value: target - balance});
  }
  ok(`${WORKERS.length + 1} agents on-chain (ids ${firstId}…${firstId + BigInt(WORKERS.length)}), ${WORKERS.length} workers bonded and funded for gas`);

  // ── 2. services ───────────────────────────────────────────────────────
  const env = {
    ...process.env,
    DATABASE_URL: DB_URL,
    ENABLED_CHAIN_IDS: String(CHAIN_ID),
    DEFAULT_CHAIN_ID: String(CHAIN_ID),
    AGENTX_CONTRACTS_ROOT: process.env.AGENTX_CONTRACTS_ROOT ?? '../agentx-contracts',
    SIGNER_DEV_PRIVATE_KEY:
      process.env.DEPLOYER_PRIVATE_KEY ??
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    // One key PER AGENT, selected by the wallet the agent is registered to.
    // A single shared key signs every transaction as the deployer, which the
    // chain rejects for anything it checks msg.sender on.
    // The workers' own keys, plus the orchestrator account's session key.
    SIGNER_DEV_PRIVATE_KEYS: [...workerKeys, hotKey].join(','),
    SIGNER_PORT: String(SIGNER_PORT),
    SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
    // Shared by the API and the signer, fresh per run.
    SIGNER_TOKEN: randomBytes(24).toString('hex'),
    // The keeper, on a key the signer never uses, so the two cannot race
    // for nonces. FUNDER only ever tops up wallets, and not during a run.
    ...(process.env.FUNDER_PRIVATE_KEY ? {KEEPER_PRIVATE_KEY: process.env.FUNDER_PRIVATE_KEY, KEEPER_INTERVAL_MS: '10000'} : {}),
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
  };

  // Every service's output, kept.
  //
  // The first `accept` 500 of the run cost an hour because the only record of
  // it was the client's side of the wire: "failed with 500", no cause. A
  // filtered stderr handler is a filter over a thing nobody has read yet.
  const logDir = 'artifacts/demo-logs';
  mkdirSync(logDir, {recursive: true});

  const start = (name, script) => {
    const child = spawn(process.execPath, [script], {env, stdio: ['ignore', 'pipe', 'pipe']});
    const sink = createWriteStream(`${logDir}/${name}.log`);
    child.stdout.pipe(sink);
    child.stderr.pipe(sink);
    child.stderr.on('data', (d) => {
      const s = String(d);
      if (/error|Error|"level":50/.test(s)) process.stderr.write(`    [${name}] ${s}`);
    });
    children.push(child);
  };
  start('signer', 'apps/signer/dist/main.js');
  start('api', 'apps/api/dist/main.js');

  const waitFor = async (url, label) => {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url)).ok) return ok(`${label} is up`);
      } catch {}
      await sleep(500);
    }
    throw new Error(`${label} never became healthy at ${url}`);
  };
  await waitFor(`http://127.0.0.1:${SIGNER_PORT}/health`, 'signer');
  await waitFor(`http://127.0.0.1:${API_PORT}/health`, 'api');

  // ── 3. register through the API ───────────────────────────────────────
  await sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, signer_txs, spend_policies RESTART IDENTITY CASCADE`;
  await sql`DELETE FROM indexer_cursor`;

  const base = `http://127.0.0.1:${API_PORT}`;
  const register = async (name, capability, price, chainAgentId, walletAddress) => {
    const res = await fetch(`${base}/v1/agents`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        name,
        capabilities: [capability],
        pricePerTask: price,
        walletAddress,
        ownerAddress: DEPLOYER.address,
        chainId: CHAIN_ID,
        // Verified by the API against the identity registry before it is
        // stored — the same path the /register page takes.
        chainAgentId: String(chainAgentId),
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`register ${name}: ${JSON.stringify(body)}`);
    return body;
  };

  const orchestratorAgent = await register('Orchestrator', 'orchestration', '0', firstId, orchestratorWallet);
  const workerAgents = [];
  for (const [i, w] of WORKERS.entries()) {
    workerAgents.push(
      await register(titleCase(w.capability), w.capability, w.price, firstId + BigInt(i + 1), workerWallets[i]),
    );
  }
  ok(`registered ${WORKERS.length} workers and the orchestrator through the API`);

  // ── 4. the indexer, running as it would in production ─────────────────
  const indexer = new Indexer({db, chain, abis});

  // Start at the head, because the only events this run cares about are the
  // ones it is about to create. The cursor was truncated above, so without
  // this the indexer restarts at the deployment block — 1.6 million blocks
  // and roughly two hours of backfill behind a demo that lasts ninety
  // seconds. Every run before this one waited for events that were never
  // going to arrive.
  const seededAt = await indexer.seedCursorToHead();
  ok(`indexer starting at block ${seededAt ?? '(existing cursor)'}`);

  // Errors are REPORTED. `.catch(() => {})` here is what kept the above
  // invisible through five failed runs.
  let indexerFailures = 0;
  const indexing = (async () => {
    while (!stopped.signal.aborted) {
      try {
        await indexer.tick();
      } catch (err) {
        // Once per distinct problem: an RPC blip every 400ms would otherwise
        // bury the run's own output.
        if (indexerFailures++ % 10 === 0) warn(`indexer: ${err.message ?? err}`);
      }
      await sleep(400);
    }
  })();

  // ── 5. the workers ────────────────────────────────────────────────────
  const workers = WORKERS.map((w, i) => {
    if (w.silent) return silentWorker(w, workerAgents[i]);
    const worker = new Worker({
      client: new AgentxClient({baseUrl: base, apiKey: workerAgents[i].apiKey, chainId: CHAIN_ID}),
      brain: buildBrain({role: 'worker'}),
      capability: w.capability,
      role: w.role,
      output: w.output,
      log: (e) => console.log(`    [${w.capability}] ${describeWorkerEvent(e)}`),
    });
    return worker.run({intervalMs: 700, signal: stopped.signal});
  });
  ok(`${WORKERS.length} workers listening for offers`);

  // ── 6. the run ────────────────────────────────────────────────────────
  const client = new AgentxClient({baseUrl: base, apiKey: orchestratorAgent.apiKey, chainId: CHAIN_ID});
  const balancesBefore = await Promise.all(
    workerWallets.map((w) => pub.readContract({address: token, abi: erc20, functionName: 'balanceOf', args: [w]})),
  );

  console.log(`\n  goal: ${GOAL}\n`);
  const events = [];
  const orchestrator = new Orchestrator({
    client,
    brain: orchestratorBrain,
    log: (e) => {
      events.push(e);
      console.log(`  ${describeEvent(e)}`);
    },
  });
  // Per step. 90s was enough for a hosted model and too tight for a local 8B
  // one on a laptop: a live chaos run had a healthy worker still generating
  // when the step gave up. A dead worker is still caught within 45s — it
  // never accepts — so this only lengthens the wait for a slow LIVE one.
  let report;
  if (process.env.DEMO_VIA_API) {
    // The way the interface runs it: POST /v1/runs with the orchestrator's
    // key, the API's own executor doing the work, the durable trace read
    // back afterwards. Otherwise the runs API is only ever exercised by
    // tests with a stubbed executor.
    const started = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${orchestratorAgent.apiKey}`},
      body: JSON.stringify({goal: GOAL}),
    });
    if (!started.ok) throw new Error(`POST /v1/runs: ${started.status} ${await started.text()}`);
    const {runId} = await started.json();
    let run;
    for (;;) {
      run = await (await fetch(`${base}/v1/runs/${runId}`)).json();
      if (run.state !== 'running') break;
      await sleep(1000);
    }
    for (const e of run.events) {
      const event = {kind: e.kind, ...e.payload};
      events.push(event);
      if (e.kind !== 'finished' && e.kind !== 'failed') console.log(`  ${describeEvent(event)}`);
    }
    report = {plan: run.steps.length > 0 ? {} : null, steps: run.steps, answer: run.answer};
    ok(`run ${runId} executed by the API (${run.state}) — its trace is at /runs/${runId}`);
  } else {
    report = await orchestrator.run(GOAL, {timeoutMs: 180_000});
  }

  // ── 7. assertions, against the chain ──────────────────────────────────
  console.log('');
  if (!report.plan) {
    console.error(
      `\n  No plan was produced — ${report.planError ?? 'the orchestrator could not reach a model'}.\n` +
        '  Set GEMINI_API_KEY (free tier) or GROQ_API_KEY and re-run, or record\n' +
        '  one run with AGENT_MODE=record to replay it free afterwards.\n',
    );
    await cleanup();
    process.exit(3);
  }

  report.steps.length > 0
    ? ok(`the plan produced ${report.steps.length} step(s)`)
    : fail('the plan produced no steps');

  // A judge rejecting work, or no agent offering a capability, is the system
  // deciding. `failed` and `timeout` are the system breaking — a missing
  // recording, a result nobody could read, a transaction that did not land.
  // This used to pass as long as ONE step settled, which is how a cached
  // replay that lost two of three recordings reported "Demo passed".
  const broken = report.steps.filter((s) => s.status === 'failed' || s.status === 'timeout');
  broken.length === 0
    ? ok('every step ended in a decision, none in a failure')
    : fail(`${broken.length} step(s) broke rather than decided: ${broken.map((s) => `${s.capability} (${s.status}: ${s.detail})`).join('; ')}`);

  const settled = report.steps.filter((s) => s.status === 'settled');
  settled.length > 0
    ? ok(`${settled.length} step(s) settled on-chain`)
    : fail(`nothing settled — outcomes were: ${report.steps.map((s) => s.status).join(', ')}`);

  // Every step must have reached a definite end. A step still "in flight" at
  // this point is the hang the acceptance criterion forbids.
  report.steps.every((s) => s.status)
    ? ok('no step was left hanging')
    : fail('a step ended without a status');

  // The assertion that cannot be faked: the money moved.
  const balancesAfter = await Promise.all(
    workerWallets.map((w) => pub.readContract({address: token, abi: erc20, functionName: 'balanceOf', args: [w]})),
  );
  const paid = balancesAfter.reduce((sum, after, i) => sum + (after - balancesBefore[i]), 0n);
  paid > 0n
    ? ok(`workers were actually paid ${chain.formatToken(paid)} in total`)
    : fail('no worker balance changed — nothing was really paid');

  // The spending happened inside the account, where the caps live. Read its
  // own counter back from the chain. It counts every hire that moved money,
  // including one later cancelled and refunded — a refund arrives as a
  // deposit, not as negative spend — so the invariant is the cap, not the sum
  // of the settled steps.
  const spentOnChain = await pub.readContract({address: orchestratorWallet, abi: accountAbi, functionName: 'spentToday'});
  spentOnChain > 0n && spentOnChain <= caps.dailyCap
    ? ok(`the orchestrator's AgentAccount recorded ${chain.formatToken(spentOnChain)} spent, on chain, within its ${chain.formatToken(caps.dailyCap)} daily cap`)
    : fail(`AgentAccount spentToday is ${spentOnChain} against a daily cap of ${caps.dailyCap}`);

  // ── x402: the same worker, paid per request over HTTP ─────────────────
  // Opt-in, so the video's timing is unchanged. The research worker opens a
  // paid endpoint; the orchestrator fetches it, gets a 402 quote, pays it
  // through the facilitator — a directPay from its AgentAccount, under the
  // same caps — and retries with the receipt. Then the receipt is replayed,
  // which must be refused: the chain records that money moved, not how many
  // times it was shown.
  if (process.env.DEMO_X402 === '1') {
    const r = WORKERS.findIndex((w) => w.capability === 'market-research' && !w.silent);
    const researchClient = new AgentxClient({baseUrl: base, apiKey: workerAgents[r].apiKey, chainId: CHAIN_ID});
    const researchInfo = await researchClient.getAgent(workerAgents[r].agentId);
    const x402Server = await serveX402({
      worker: new Worker({
        client: researchClient,
        brain: buildBrain({role: 'worker'}),
        capability: WORKERS[r].capability,
        role: WORKERS[r].role,
        output: WORKERS[r].output,
      }),
      client: researchClient,
      port: 0,
      agentId: workerAgents[r].agentId,
      price: researchInfo.pricePerTask,
      payTo: researchInfo.walletAddress,
      asset: token,
      network: `eip155:${CHAIN_ID}`,
      log: (e) => console.log(`    [x402] ${e.kind}${e.reason ? ` — ${e.reason}` : ''}${e.jobId ? ` job ${e.jobId}` : ''}`),
    });
    const x402Url = x402Server.url;
    const question = {input: {question: 'What is the typical 2% order-book depth for ETH/USDC on major venues?'}};

    const unpaid = await fetch(x402Url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(question)});
    unpaid.status === 402
      ? ok(`x402: unpaid request answered 402, quoting ${chain.formatToken(BigInt((await unpaid.json()).accepts[0].maxAmountRequired))}`)
      : fail(`x402: an unpaid request got ${unpaid.status}, not 402`);

    const x402Started = Date.now();
    const {response, settlement} = await client.payX402(x402Url, {maxAmount: '30000', body: question});
    const answered = await response.json();
    response.status === 200 && answered.output
      ? ok(`x402: paid ${settlement.transaction.slice(0, 12)}… and served in ${((Date.now() - x402Started) / 1000).toFixed(1)} s — ${chain.explorerTx(settlement.transaction)}`)
      : fail(`x402: paid, then got ${response.status}: ${JSON.stringify(answered)}`);

    // The chain, not our word for it.
    const x402Receipt = await pub.getTransactionReceipt({hash: settlement.transaction});
    const directPaid = parseEventLogs({abi: abis['TaskEscrow'], logs: x402Receipt.logs, eventName: 'DirectPaid'});
    directPaid.some((e) => e.args.workerAgentId === firstId + BigInt(r + 1))
      ? ok(`x402: DirectPaid on chain to worker ${firstId + BigInt(r + 1)}, ${chain.formatToken(directPaid[0].args.amount)}`)
      : fail('x402: no DirectPaid to the research worker in the settlement receipt');

    const replayed = await fetch(x402Url, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-payment': settlement.paymentHeader},
      body: JSON.stringify(question),
    });
    const replayBody = await replayed.json();
    replayed.status === 402 && replayBody.error === 'already_redeemed'
      ? ok('x402: the same receipt replayed was refused — already_redeemed')
      : fail(`x402: a replayed receipt got ${replayed.status} ${JSON.stringify(replayBody)}`);

    await x402Server.close();
  }

  // ── a stolen worker key, tried against its own account ────────────────
  // Simulated with eth_call AS the worker's session key: no gas, no state,
  // and the same checks a broadcast would meet. Each must be refused by the
  // account itself — a refusal from our signer would prove nothing about a
  // key that has left it.
  const refusedBy = async (label, args, expected) => {
    try {
      await pub.simulateContract({account: workerAccounts[0], address: workerWallets[0], abi: accountAbi, ...args});
      fail(`a stolen worker key could ${label}`);
    } catch (err) {
      const name = err.cause?.data?.errorName ?? err.cause?.reason ?? err.shortMessage;
      name === expected
        ? ok(`a stolen worker key cannot ${label} — ${expected}`)
        : fail(`${label}: expected ${expected}, got ${name}`);
    }
  };
  await refusedBy(
    'move the earnings (USDC transfer)',
    {functionName: 'execute', args: [token, encodeFunctionData({abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 1n]})]},
    'TargetNotAllowed',
  );
  await refusedBy(
    'hire another agent (createJob)',
    {functionName: 'execute', args: [escrow, encodeFunctionData({abi: abis['TaskEscrow'], functionName: 'createJob', args: [firstId + 1n, firstId + 2n, 1n, `0x${'00'.repeat(32)}`, 3600n, 3600n]})]},
    'SelectorNotAllowed',
  );
  await refusedBy('sweep the account to itself', {functionName: 'sweep', args: [workerAccounts[0].address, 1n]}, 'NotOwner');

  // The earnings are the owner's. `sweep` is the one way money leaves a
  // worker's account, and only the owner can call it.
  const ownerBefore = await pub.readContract({address: token, abi: erc20, functionName: 'balanceOf', args: [DEPLOYER.address]});
  let swept = 0n;
  for (const account of workerWallets) {
    const held = await pub.readContract({address: token, abi: erc20, functionName: 'balanceOf', args: [account]});
    if (held === 0n) continue;
    await write(account, accountAbi, 'sweep', [DEPLOYER.address, held]);
    swept += held;
  }
  const ownerAfter = await pub.readContract({address: token, abi: erc20, functionName: 'balanceOf', args: [DEPLOYER.address]});
  swept > 0n && ownerAfter - ownerBefore === swept
    ? ok(`the owner swept ${chain.formatToken(swept)} of earnings out of the worker accounts`)
    : fail(`sweep moved ${ownerAfter - ownerBefore}, expected ${swept}`);

  // Wait for the indexer to catch up, then check reputation came from a
  // settlement rather than from our own optimistic write.
  for (let i = 0; i < 40 && !(await reputationWritten()); i++) await sleep(500);
  const stats = await sql`SELECT agent_id, completed, score FROM agent_stats WHERE completed > 0`;
  stats.length > 0
    ? ok(`reputation written from settlement: ${stats.map((s) => `agent ${s.agent_id} completed=${s.completed} score=${s.score}`).join(', ')}`)
    : fail('no reputation was written — settlement did not reach the projection');

  if (CHAOS) {
    const silentId = workerAgents[WORKERS.length - 1].agentId;
    const retried = events.find((e) => e.kind === 'retrying');
    const [stranded] = await sql`SELECT id, chain_job_id, state FROM jobs WHERE worker_agent_id = ${silentId}`;
    if (!stranded) {
      fail('chaos was not exercised: the selector never hired the broken worker — re-run');
    } else {
      retried
        ? ok(`the broken worker's job ${stranded.id} was abandoned and the step re-hired: ${retried.reason}`)
        : fail('the broken worker was hired but the step was never retried');
      const step = report.steps.find((s) => s.capability === WORKERS[1].capability);
      step?.status === 'settled' && step.agentId !== silentId
        ? ok(`${step.capability} still delivered, by agent ${step.agentId}`)
        : fail(`${WORKERS[1].capability} did not recover: ${step?.status} — ${step?.detail}`);
      if (CHAOS === 'no-accept') {
        stranded.state === 'refunded'
          ? ok(`job ${stranded.id} was cancelled and refunded immediately`)
          : fail(`job ${stranded.id} should be refunded, is ${stranded.state}`);
      } else {
        const onChain = await pub.readContract({
          address: escrow,
          abi: abis['TaskEscrow'],
          functionName: 'getJob',
          args: [BigInt(stranded.chain_job_id)],
        });
        ok(
          `job ${stranded.id} (chain ${stranded.chain_job_id}) is ${stranded.state}, held in escrow until ` +
            `${new Date(Number(onChain.workDeadline) * 1000).toISOString()} — then run: ` +
            `node scripts/keeper-sweep.mjs ${stranded.chain_job_id}`,
        );
      }
    }
  }

  for (const step of report.steps) {
    const mark = step.status === 'settled' ? '·' : '!';
    console.log(`  ${mark} ${step.capability}: ${step.status} — ${step.detail}`);
    if (step.explorerUrl) console.log(`      ${step.explorerUrl}`);
  }

  if (report.answer) console.log(`\n  answer: ${report.answer}\n`);

  await Promise.race([Promise.all(workers), sleep(100)]);
  await Promise.race([indexing, sleep(100)]);
} catch (err) {
  fail(`demo aborted: ${err.message}`);
} finally {
  await cleanup();
}

console.log(failures ? `\nFAILED (${failures})\n` : '\nDemo passed.\n');
process.exit(failures ? 1 : 0);

async function reputationWritten() {
  const rows = await sql`SELECT 1 FROM agent_stats WHERE completed > 0 LIMIT 1`;
  return rows.length > 0;
}

/**
 * A worker that is registered and hireable, and broken. `no-accept` is a
 * process that died before it saw the offer; `mid-job` accepted, then died.
 */
async function silentWorker(w, agent) {
  if (w.silent === 'no-accept') return;
  const client = new AgentxClient({baseUrl: `http://127.0.0.1:${API_PORT}`, apiKey: agent.apiKey, chainId: CHAIN_ID});
  while (!stopped.signal.aborted) {
    const [offer] = await client.listJobs({role: 'worker', state: 'created'}).catch(() => []);
    if (offer) {
      try {
        await client.accept(offer.jobId);
        console.log(`    [${w.capability} — broken] accepted job ${offer.jobId}, and dies`);
        return;
      } catch {
        // "not confirmed on-chain yet" until the indexer links the job, which
        // the real Worker waits out too. Everything else about this worker is
        // broken; accepting has to work, or it cannot die mid-job.
      }
    }
    await sleep(700);
  }
}

function describeEvent(e) {
  switch (e.kind) {
    case 'planned':
      return `plan      ${e.subtasks} subtask(s) — ${e.reasoning}`;
    case 'plan-failed':
      return `plan      FAILED — ${e.reason}`;
    case 'discovered':
      return `discover  ${e.capability}: ${e.candidates} candidate(s)`;
    case 'selected':
      return `select    agent ${e.agentId} at ${e.price} — ${e.reason}`;
    case 'hired':
      return `hire      job ${e.jobId} for ${e.amount}\n            ${e.explorerUrl}`;
    case 'judged':
      return `judge     job ${e.jobId}: ${e.accept ? 'accept' : 'reject'} (quality ${e.quality})${
        e.injectionAttempted ? '  ⚠ INJECTION ATTEMPT IN RESULT' : ''
      }`;
    case 'settled':
      return `settle    job ${e.jobId} paid\n            ${e.explorerUrl}`;
    case 'disputed':
      return `dispute   job ${e.jobId}: ${e.reason}`;
    case 'retrying':
      return `retry     job ${e.jobId}: ${e.reason} — asking another agent`;
    case 'skipped':
      return `skip      ${e.capability}: ${e.status} — ${e.detail}`;
    default:
      return JSON.stringify(e);
  }
}

function describeWorkerEvent(e) {
  switch (e.kind) {
    case 'offer':
      return `offered job ${e.jobId}`;
    case 'declined':
      return `declined job ${e.jobId} (${e.structural ? 'cannot produce' : 'judgement'}): ${e.reason}`;
    case 'accepted':
      return `accepted job ${e.jobId}`;
    case 'delivered':
      return `delivered job ${e.jobId} via ${e.provider} in ${e.latencyMs}ms`;
    case 'failed':
      return `FAILED job ${e.jobId} at ${e.stage}: ${e.reason}`;
    default:
      return JSON.stringify(e);
  }
}

/**
 * A function DECLARATION, not a const arrow.
 *
 * It is called from the registration loop near the top of the file, and a
 * `const` declared down here sits in the temporal dead zone until execution
 * reaches it — so the first real run of this script died with "Cannot access
 * 'titleCase' before initialization", after it had already put four agents
 * on chain. Declarations hoist; consts do not.
 */
function titleCase(s) {
  return s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
