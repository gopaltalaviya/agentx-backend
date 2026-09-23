import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@agentx/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@agentx/db';
import {buildApp, EventBus} from '../src/app.js';
import type {RunContext, RunExecutor, RunResult} from '../src/runs.js';

/**
 * Orchestrator runs over HTTP.
 *
 * The executor is injected, so these need no model and no chain. What is
 * under test is the contract the live demo page depends on: an id that comes
 * back before any work happens, a trace that is durable rather than only
 * streamed, and a run that always reaches a terminal state — "running
 * forever" is the one outcome a viewer cannot interpret.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';

let app: FastifyInstance;
let db: Db;
/** Swapped per test. Receives the context so a test can emit its own trace. */
let execute: RunExecutor = async () => DELIVERED;

const DELIVERED: RunResult = {answer: 'done', spent: '20000', steps: [], delivered: true};

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    db,
    chains: config.chains as Record<number, never>,
    defaultChainId: 31337,
    bus: new EventBus(),
    runExecutor: (ctx) => execute(ctx),
    submit: async () => ({txHash: `0x${'ef'.repeat(32)}`, chainJobId: '1'}),
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  execute = async () => DELIVERED;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events RESTART IDENTITY CASCADE`,
  );
});

async function register(): Promise<{agentId: number; apiKey: string}> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: {
      name: 'RunBot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: '0x' + '11'.repeat(20),
      ownerAddress: '0x' + '22'.repeat(20),
    },
  });
  return res.json() as {agentId: number; apiKey: string};
}

const auth = (apiKey: string) => ({authorization: `Bearer ${apiKey}`});

/** Poll until the run leaves `running`, since starting one returns immediately. */
async function settle(runId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const body = (await app.inject({method: 'GET', url: `/v1/runs/${runId}`})).json();
    if (body.state !== 'running') return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${runId} never left "running"`);
}

describe('POST /v1/runs', () => {
  it('returns an id before the work happens, so a page can subscribe first', async () => {
    const {apiKey} = await register();
    let released: () => void = () => {};
    execute = async () => {
      await new Promise<void>((r) => (released = r));
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'find the deepest ETH/USDC venue'},
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toBeTruthy();
    expect(res.json().eventsUrl).toBe(`/v1/runs/${res.json().runId}/events`);

    // Still running, because the executor has not been let go.
    expect((await app.inject({method: 'GET', url: `/v1/runs/${res.json().runId}`})).json().state).toBe(
      'running',
    );
    released();
    await settle(res.json().runId);
  });

  it('requires a key, because starting a run spends', async () => {
    const res = await app.inject({method: 'POST', url: '/v1/runs', payload: {goal: 'x y z'}});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects an empty goal rather than starting a run that cannot be planned', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: ''},
    });
    expect(res.statusCode).toBe(422);
  });

  /**
   * The orchestrator acts AS the caller: it hires under that identity and
   * spends under that agent's on-chain caps. A run carrying anything else
   * would not be bounded by the caps the owner actually set.
   */
  it('carries the caller identity into the run', async () => {
    const {agentId, apiKey} = await register();
    let seen: RunContext | undefined;
    execute = async (ctx) => {
      seen = ctx;
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });
    await settle(res.json().runId);

    expect(seen?.agentId).toBe(agentId);
    expect(seen?.apiKey).toBe(apiKey);
    expect(seen?.goal).toBe('a goal');
  });
});

describe('a run always reaches a terminal state', () => {
  it('records the answer and what it cost', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    expect(run.state).toBe('done');
    expect(run.answer).toBe('done');
    expect(run.spent).toBe('20000');
  });

  /** A run that throws must still end somewhere a viewer can read. */
  it('ends as failed with a reason when the orchestrator throws', async () => {
    const {apiKey} = await register();
    execute = async () => {
      throw new Error('every provider is rate limited');
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    expect(run.state).toBe('failed');
    expect(run.error).toMatch(/rate limited/);
  });

  it('emits a terminal event either way', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    const kinds = (run.events as {kind: string}[]).map((e) => e.kind);
    expect(kinds).toContain('finished');
  });
});

describe('the trace', () => {
  /**
   * Durable, not merely streamed: the page may be refreshed, opened late, or
   * revisited after the run is over — and a finished run is the artefact
   * worth keeping.
   */
  it('survives the run and is readable afterwards, in order', async () => {
    const {apiKey} = await register();
    execute = async (ctx) => {
      await ctx.emit({kind: 'planned', subtasks: 2});
      await ctx.emit({kind: 'hired', jobId: '1'});
      await ctx.emit({kind: 'settled', jobId: '1'});
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    expect((run.events as {kind: string}[]).map((e) => e.kind)).toEqual([
      'planned',
      'hired',
      'settled',
      'finished',
    ]);
  });

  it('keeps each event payload intact for rendering', async () => {
    const {apiKey} = await register();
    execute = async (ctx) => {
      await ctx.emit({kind: 'hired', jobId: '7', explorerUrl: 'https://explorer/tx/0xabc'});
      return DELIVERED;
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });

    const run = await settle(res.json().runId);
    const hired = (run.events as {kind: string; payload: Record<string, unknown>}[]).find(
      (e) => e.kind === 'hired',
    );
    expect(hired?.payload).toEqual({jobId: '7', explorerUrl: 'https://explorer/tx/0xabc'});
  });

  /**
   * Watching a run is the thing being demonstrated. A judge following a link
   * should not need a key for it.
   */
  it('is readable without credentials', async () => {
    const {apiKey} = await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: auth(apiKey),
      payload: {goal: 'a goal'},
    });
    await settle(res.json().runId);

    const anonymous = await app.inject({method: 'GET', url: `/v1/runs/${res.json().runId}`});
    expect(anonymous.statusCode).toBe(200);
  });
});

describe('a deployment with no model', () => {
  it('serves everything else and refuses to start a run with a real error', async () => {
    const bare = await buildApp({
      db,
      chains: config.chains as Record<number, never>,
      defaultChainId: 31337,
      bus: new EventBus(),
      submit: async () => ({txHash: '0x', chainJobId: '1'}),
    });

    try {
      expect((await bare.inject({method: 'GET', url: '/health'})).json().orchestrator).toBe(false);

      const {apiKey} = await register();
      const res = await bare.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: auth(apiKey),
        payload: {goal: 'a goal'},
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json().detail).toMatch(/no orchestrator configured/);
    } finally {
      await bare.close();
    }
  });
});
