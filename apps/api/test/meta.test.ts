import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@agentx/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@agentx/db';
import {buildApp, EventBus} from '../src/app.js';
import type {BudgetReader, BudgetReading} from '../src/chain-reads.js';

/**
 * `/v1/network` and `/v1/budget` — the two things an autonomous agent must be
 * able to learn before it spends.
 *
 * The budget reader is injected, so these run without an RPC. What is under
 * test is the part that is ours: which source answered, how the two caps
 * combine, and that a failing chain read degrades instead of erroring.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';

let app: FastifyInstance;
let db: Db;
/** Swapped per test; `null` means "not an AgentAccount, or RPC down". */
let reading: BudgetReading | null | 'throw' = null;

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

const readBudget: BudgetReader = async () => {
  if (reading === 'throw') throw new Error('RPC unreachable');
  return reading;
};

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    db,
    chains: config.chains as Record<number, never>,
    defaultChainId: 31337,
    bus: new EventBus(),
    readBudget,
    submit: async () => ({txHash: `0x${'cd'.repeat(32)}`, chainJobId: '1'}),
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  reading = null;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, spend_policies RESTART IDENTITY CASCADE`,
  );
});

async function register(): Promise<{agentId: number; apiKey: string}> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: {
      name: 'BudgetBot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: '0x' + '11'.repeat(20),
      ownerAddress: '0x' + '22'.repeat(20),
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {agentId: number; apiKey: string};
}

const auth = (apiKey: string) => ({authorization: `Bearer ${apiKey}`});

describe('GET /v1/network', () => {
  it('answers without credentials, because a client checks the network before holding a key', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/network'});
    expect(res.statusCode).toBe(200);
    expect(res.json().chainId).toBe(31337);
  });

  /** The field that stops an agent treating real money as play money. */
  it('states whether the money is real', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(typeof body.testnet).toBe('boolean');
  });

  it('reports the windows an agent must plan against, in seconds', async () => {
    const {windows} = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(windows.accept).toBeGreaterThan(0);
    expect(windows.work).toBeGreaterThan(0);
    expect(windows.review).toBeGreaterThan(0);
  });

  it('reports the fast-path threshold, so a caller can predict which path a hire takes', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network'})).json();
    expect(BigInt(body.fastPathMax)).toBeGreaterThan(0n);
    expect(body.fastPathMaxDisplay).toMatch(/\d/);
  });

  it('falls back to the default chain rather than erroring on an unknown one', async () => {
    const body = (await app.inject({method: 'GET', url: '/v1/network?chainId=99999'})).json();
    expect(body.chainId).toBe(31337);
  });
});

describe('GET /v1/budget', () => {
  it('requires a key — a budget is not public information', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/budget'});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('prefers the chain and says so', async () => {
    const {apiKey} = await register();
    reading = {
      perTaskCap: 50_000n,
      dailyCap: 500_000n,
      dailyRemaining: 300_000n,
      allowlistOnly: false,
      tokenBalance: 1_000_000n,
      dayStart: BigInt(Math.floor(Date.now() / 1000)),
    };

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.source).toBe('chain');
    expect(body.dailyRemaining).toBe('300000');
    expect(body.tokenBalance).toBe('1000000');
  });

  /**
   * The number an agent actually plans against. Reporting the caps separately
   * and leaving the agent to combine them is how you get a hire that passes
   * the per-task check and reverts on the daily one.
   */
  it('reports the tighter of the two caps as the most one hire can cost', async () => {
    const {apiKey} = await register();
    reading = {
      perTaskCap: 50_000n,
      dailyCap: 500_000n,
      dailyRemaining: 20_000n, // today's remainder is now the binding limit
      allowlistOnly: false,
      tokenBalance: 0n,
      dayStart: BigInt(Math.floor(Date.now() / 1000)),
    };

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.maxSingleSpend).toBe('20000');
  });

  it('falls back to the cached policy when the wallet is not an AgentAccount', async () => {
    const {agentId, apiKey} = await register();
    reading = null;
    await db.execute(
      sql`INSERT INTO spend_policies (agent_id, per_task_cap, daily_cap, spent_today)
          VALUES (${agentId}, '40000', '400000', '150000')`,
    );

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.source).toBe('cache');
    expect(body.dailyRemaining).toBe('250000');
  });

  /**
   * The failure that matters: an unreachable RPC must not take the budget
   * endpoint down with it, because an agent that cannot read its budget
   * reverts to learning it from 402s.
   */
  it('degrades to the cache when the chain read throws, rather than failing', async () => {
    const {apiKey} = await register();
    reading = 'throw';

    const res = await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)});
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('cache');
  });

  it('never reports a negative remainder when spending has overrun the cache', async () => {
    const {agentId, apiKey} = await register();
    await db.execute(
      sql`INSERT INTO spend_policies (agent_id, per_task_cap, daily_cap, spent_today)
          VALUES (${agentId}, '40000', '100000', '150000')`,
    );

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.dailyRemaining).toBe('0');
    expect(body.maxSingleSpend).toBe('0');
  });

  /**
   * The contract's window rolls 24h from the first spend. Answering "resets at
   * UTC midnight" would send an agent to sleep for the wrong duration.
   */
  it('counts the reset from the contract clock, not from UTC midnight', async () => {
    const {apiKey} = await register();
    const twoHoursAgo = BigInt(Math.floor(Date.now() / 1000) - 2 * 3600);
    reading = {
      perTaskCap: 50_000n,
      dailyCap: 500_000n,
      dailyRemaining: 500_000n,
      allowlistOnly: false,
      tokenBalance: 0n,
      dayStart: twoHoursAgo,
    };

    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.resetsInSeconds).toBeGreaterThan(21 * 3600);
    expect(body.resetsInSeconds).toBeLessThanOrEqual(22 * 3600);
  });

  it('reports a full window as already reset when nothing has been spent', async () => {
    const {apiKey} = await register();
    const body = (await app.inject({method: 'GET', url: '/v1/budget', headers: auth(apiKey)})).json();
    expect(body.resetsInSeconds).toBe(0);
  });
});
