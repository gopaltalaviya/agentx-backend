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
 * Exit codes: 0 all assertions passed, 1 an assertion failed, 3 no brain is
 * reachable (nothing was spent and nothing was proven).
 */

import {spawn} from 'node:child_process';
import {createPublicClient, createWalletClient, http, parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {foundry} from 'viem/chains';
import postgres from 'postgres';
import {z} from 'zod';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb, closeDb} from '@agentx/db';
import {AgentxClient} from '@agentx/sdk';
import {Orchestrator, Worker, buildBrain, describeBrain} from '@agentx/agent-core';
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
      confidence: z.number().min(0).max(1),
    }),
  },
  {
    capability: 'trade-analysis',
    price: '25000',
    role: 'a trading analysis agent that recommends a position with explicit risks',
    output: z.object({
      recommendation: z.enum(['buy', 'sell', 'hold']),
      rationale: z.string().min(40).max(1_000),
      confidence: z.number().min(0).max(1),
      risks: z.array(z.string().min(10)).min(1).max(4),
    }),
  },
  {
    capability: 'trade-execution',
    price: '30000',
    role: 'an execution planning agent that produces an ordered plan with an abort condition',
    output: z.object({
      steps: z.array(z.object({action: z.string().min(5)})).min(1).max(6),
      preconditions: z.array(z.string().min(5)).min(1).max(5),
      abortIf: z.string().min(10),
    }),
  },
];

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
  const write = async (address, abi, fn, args) =>
    pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({address, abi, functionName: fn, args}),
    });

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

  // The orchestrator, then one identity per worker. Each worker is paid to a
  // DISTINCT address so the balance assertions measure something real.
  await write(identity, abis['MockIdentityRegistry'], 'register', ['ipfs://orchestrator', DEPLOYER.address]);
  const workerWallets = WORKERS.map((_, i) => `0x${String(i + 1).repeat(40)}`);
  for (const [i, w] of WORKERS.entries()) {
    await write(identity, abis['MockIdentityRegistry'], 'register', [`ipfs://${w.capability}`, workerWallets[i]]);
    await write(vault, abis['StakeVault'], 'deposit', [firstId + BigInt(i + 1), 10_000_000n]);
  }
  ok(`4 agents on-chain (ids ${firstId}…${firstId + 3n}), 3 workers bonded`);

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
    SIGNER_PORT: String(SIGNER_PORT),
    SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
    PORT: String(API_PORT),
    LOG_LEVEL: 'warn',
  };

  const start = (name, script) => {
    const child = spawn(process.execPath, [script], {env, stdio: ['ignore', 'pipe', 'pipe']});
    child.stderr.on('data', (d) => {
      if (/error|Error/.test(String(d))) process.stderr.write(`    [${name}] ${d}`);
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
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`register ${name}: ${JSON.stringify(body)}`);
    await sql`UPDATE agents SET chain_agent_id = ${chainAgentId} WHERE id = ${body.agentId}`;
    return body;
  };

  const orchestratorAgent = await register('Orchestrator', 'orchestration', '0', firstId, DEPLOYER.address);
  const workerAgents = [];
  for (const [i, w] of WORKERS.entries()) {
    workerAgents.push(
      await register(titleCase(w.capability), w.capability, w.price, firstId + BigInt(i + 1), workerWallets[i]),
    );
  }
  ok(`registered ${WORKERS.length} workers and the orchestrator through the API`);

  // ── 4. the indexer, running as it would in production ─────────────────
  const indexer = new Indexer({db, chain, abis});
  const indexing = (async () => {
    while (!stopped.signal.aborted) {
      await indexer.tick().catch(() => {});
      await sleep(400);
    }
  })();

  // ── 5. the workers ────────────────────────────────────────────────────
  const workers = WORKERS.map((w, i) => {
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
  const orchestrator = new Orchestrator({
    client,
    brain: orchestratorBrain,
    log: (e) => console.log(`  ${describeEvent(e)}`),
  });
  const report = await orchestrator.run(GOAL, {timeoutMs: 90_000});

  // ── 7. assertions, against the chain ──────────────────────────────────
  console.log('');
  if (!report.plan) {
    console.error(
      '\n  No plan was produced — the orchestrator could not reach a model.\n' +
        '  Set GEMINI_API_KEY (free tier) or GROQ_API_KEY and re-run, or record\n' +
        '  one run with AGENT_MODE=record to replay it free afterwards.\n',
    );
    await cleanup();
    process.exit(3);
  }

  report.steps.length > 0
    ? ok(`the plan produced ${report.steps.length} step(s), all of them resolved`)
    : fail('the plan produced no steps');

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

  // Wait for the indexer to catch up, then check reputation came from a
  // settlement rather than from our own optimistic write.
  for (let i = 0; i < 40 && !(await reputationWritten()); i++) await sleep(500);
  const stats = await sql`SELECT agent_id, completed, score FROM agent_stats WHERE completed > 0`;
  stats.length > 0
    ? ok(`reputation written from settlement: ${stats.map((s) => `agent ${s.agent_id} completed=${s.completed} score=${s.score}`).join(', ')}`)
    : fail('no reputation was written — settlement did not reach the projection');

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

function describeEvent(e) {
  switch (e.kind) {
    case 'planned':
      return `plan      ${e.subtasks} subtask(s) — ${e.reasoning}`;
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

const titleCase = (s) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
