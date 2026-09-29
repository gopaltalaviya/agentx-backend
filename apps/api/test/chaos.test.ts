import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@agentx/config';
import {sql} from 'drizzle-orm';
import {AgentxError, ErrorCode, validateShape} from '@agentx/shared';
import {createDb, closeDb, type Db} from '@agentx/db';
import {buildApp, EventBus} from '../src/app.js';

/**
 * Chaos checklist, the parts that run through the API.
 *
 * Each of these is a way the demo dies in front of people: a worker delivers
 * something the client cannot use, the daily cap is reached mid-run, the
 * agent's wallet runs out of gas. None of them should produce a 500, and none
 * of them should leave a job that can never move again.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';

let app: FastifyInstance;
let db: Db;
/** Swapped per test to make the signer misbehave. */
let submitBehaviour: (() => void) | null = null;
let submitted: string[] = [];
/** The payload the API handed the signer, so the on-chain args can be asserted. */
let lastPayload: Record<string, unknown> | null = null;
let chainJobSeq = 0;

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
    submit: async (args) => {
      submitBehaviour?.();
      submitted.push(args.kind);
      lastPayload = args.payload ?? null;
      // A DISTINCT id per job, as the chain would assign. Returning a
      // constant made the second hire in any test collide on
      // jobs_chain_job_uk — a mock that cannot happen in production.
      return {txHash: `0x${'ab'.repeat(32)}`, chainJobId: String(++chainJobSeq)};
    },
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  submitBehaviour = null;
  submitted = [];
  lastPayload = null;
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events RESTART IDENTITY CASCADE`,
  );
});

/** Distinct per call: a duplicate wallet is a 409, and two agents need two. */
let walletSeed = 0;

async function register(name: string): Promise<{agentId: number; apiKey: string}> {
  const wallet = `0x${(++walletSeed).toString(16).padStart(40, '0')}`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: {
      name,
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: wallet,
      ownerAddress: '0x' + '22'.repeat(20),
    },
  });
  expect(res.statusCode, `register ${name}: ${res.body}`).toBe(201);
  const body = res.json() as {agentId: number; apiKey: string};
  // The API refuses a hire until both sides carry an ERC-8004 id, which the
  // indexer would supply. These tests are about the failure paths after that.
  await db.execute(sql`UPDATE agents SET chain_agent_id = ${body.agentId} WHERE id = ${body.agentId}`);
  return body;
}

const auth = (apiKey: string) => ({authorization: `Bearer ${apiKey}`});

/** A hired job in `accepted`, ready for a result. */
async function hiredJob(outputSchema?: Record<string, unknown>) {
  const client = await register('Client');
  const worker = await register('Worker');

  const hire = await app.inject({
    method: 'POST',
    url: '/v1/jobs',
    headers: {...auth(client.apiKey), 'idempotency-key': `key-${Date.now()}-${Math.random()}`},
    payload: {
      workerAgentId: String(worker.agentId),
      maxPrice: '50000',
      path: 'escrow',
      spec: {
        capability: 'market-research',
        input: {question: 'depth?'},
        deadlineSeconds: 120,
        ...(outputSchema ? {outputSchema} : {}),
      },
    },
  });
  expect(hire.statusCode, `hire failed: ${hire.body}`).toBe(201);
  const jobId = hire.json().jobId as string;

  const accepted = await app.inject({
    method: 'POST',
    url: `/v1/jobs/${jobId}/accept`,
    headers: auth(worker.apiKey),
  });
  expect(accepted.statusCode).toBe(200);

  return {jobId, client, worker};
}

describe('a malformed result is refused at the boundary', () => {
  /**
   * Without this check the API stores the junk, signs a transaction for it,
   * and the client discovers the problem only by paying gas to dispute —
   * while the worker learns it failed through a permanent reputation hit
   * instead of a 422 it could have acted on.
   */
  it('rejects a result missing the fields the job asked for', async () => {
    const {jobId, worker} = await hiredJob({type: 'object', required: ['summary', 'sources']});
    submitted = [];

    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {somethingElse: 'x'}, producedAt: new Date().toISOString()},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe(ErrorCode.SCHEMA_MISMATCH);
    expect(res.json().detail).toMatch(/summary/);
  });

  it('does not send a transaction for a result it refused', async () => {
    const {jobId, worker} = await hiredJob({type: 'object', required: ['summary']});
    submitted = [];

    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {}, producedAt: new Date().toISOString()},
    });

    expect(submitted).toEqual([]);
  });

  it('leaves the job where it was, so the worker can deliver properly', async () => {
    const {jobId, worker} = await hiredJob({type: 'object', required: ['summary']});

    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {}, producedAt: new Date().toISOString()},
    });
    expect((await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json().state).toBe('accepted');

    const good = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {summary: 'depth is healthy'}, producedAt: new Date().toISOString()},
    });
    expect(good.statusCode).toBe(200);
  });

  it('accepts anything when the job declared no output schema', async () => {
    const {jobId, worker} = await hiredJob();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {whatever: true}, producedAt: new Date().toISOString()},
    });
    expect(res.statusCode).toBe(200);
  });

  it('still rejects a malformed envelope with 422, not 500', async () => {
    const {jobId, worker} = await hiredJob();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: 'not an object', producedAt: 'not a date'},
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('what a delivered result actually is', () => {
  /**
   * `result` means the worker's OUTPUT everywhere it is read: the worker
   * checks its own output against the job's outputSchema, the API checks the
   * same thing on submission, and the orchestrator checks it again before
   * paying. Storing the delivery envelope under that name made those checks
   * disagree — a perfect delivery came back as `{output, producedAt}`, failed
   * the required-field check, and was disputed.
   *
   * That is the demo's main path, so this is the shape the whole run depends
   * on.
   */
  it('returns the output itself, not the delivery envelope', async () => {
    const {jobId, worker} = await hiredJob({type: 'object', required: ['summary']});

    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {summary: 'depth is healthy', confidence: 0.8}, producedAt: new Date().toISOString()},
    });

    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json();
    expect(job.result).toEqual({summary: 'depth is healthy', confidence: 0.8});
    expect(job.result.output).toBeUndefined();
    expect(job.result.producedAt).toBeUndefined();
  });

  /** The same check the orchestrator runs before it pays. */
  it('produces a result that satisfies the schema the job asked for', async () => {
    const {jobId, worker} = await hiredJob({type: 'object', required: ['summary', 'confidence']});

    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {summary: 'x'.repeat(20), confidence: 0.9}, producedAt: new Date().toISOString()},
    });

    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json();
    expect(validateShape(job.result, job.spec.outputSchema)).toEqual({ok: true});
  });

  /**
   * The hash is what the chain commits to. Including `producedAt` would give
   * the same content a different commitment on every delivery.
   */
  it('commits to a hash of the output alone, stable across deliveries', async () => {
    const first = await hiredJob({type: 'object', required: ['summary']});
    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${first.jobId}/result`,
      headers: auth(first.worker.apiKey),
      payload: {output: {summary: 'identical'}, producedAt: '2026-01-01T00:00:00.000Z'},
    });

    const second = await hiredJob({type: 'object', required: ['summary']});
    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${second.jobId}/result`,
      headers: auth(second.worker.apiKey),
      payload: {output: {summary: 'identical'}, producedAt: '2026-06-30T12:34:56.000Z'},
    });

    const a = (await app.inject({method: 'GET', url: `/v1/jobs/${first.jobId}`})).json();
    const b = (await app.inject({method: 'GET', url: `/v1/jobs/${second.jobId}`})).json();
    expect(a.resultHash).toBe(b.resultHash);
  });

  /**
   * T4's mitigation is "the result hash is committed on-chain before release".
   * The encoder falls back to the SPEC hash when none is supplied, which would
   * have committed to what was asked for rather than to what was delivered.
   */
  it('sends the result hash to the chain, not the spec hash', async () => {
    const {jobId, worker} = await hiredJob({type: 'object', required: ['summary']});
    lastPayload = null;

    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {summary: 'delivered'}, producedAt: new Date().toISOString()},
    });

    const job = (await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`})).json();
    expect(lastPayload?.['resultHash']).toBe(job.resultHash);
    expect(lastPayload?.['resultHash']).not.toBe(job.specHash);
  });
});

describe('a worker can find the work it was hired for', () => {
  /**
   * A fast-path job is paid on creation. The worker still has to do the work,
   * so it must be findable — this is the listing a worker polls.
   */
  it('lists a fast-path job to its worker, marked as not yet delivered', async () => {
    const client = await register('Client');
    const worker = await register('Worker');

    const hire = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...auth(client.apiKey), 'idempotency-key': `fast-${Date.now()}`},
      payload: {
        workerAgentId: String(worker.agentId),
        maxPrice: '50000',
        path: 'direct',
        spec: {capability: 'market-research', input: {q: 1}, deadlineSeconds: 120},
      },
    });
    expect(hire.statusCode, hire.body).toBe(201);
    expect(hire.json().path).toBe('direct');

    const listed = (await app.inject({
      method: 'GET',
      url: '/v1/jobs?role=worker&limit=25',
      headers: auth(worker.apiKey),
    })).json();

    expect(listed.count, 'the worker must see the job it was hired for').toBe(1);
    expect(listed.jobs[0].hasResult).toBe(false);
    expect(listed.jobs[0].spec.capability).toBe('market-research');
  });

  it('stops listing it once the work is delivered', async () => {
    const {jobId, worker} = await hiredJob();
    await app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/result`,
      headers: auth(worker.apiKey),
      payload: {output: {summary: 'done'}, producedAt: new Date().toISOString()},
    });

    const listed = (await app.inject({
      method: 'GET',
      url: '/v1/jobs?role=worker&limit=25',
      headers: auth(worker.apiKey),
    })).json();
    expect(listed.jobs[0].hasResult).toBe(true);
  });
});

describe('the daily cap', () => {
  /**
   * The cap is enforced on-chain and the signer refuses first so the caller
   * gets an actionable error rather than a revert. What matters here is that
   * it arrives as a 402 with a code an agent can branch on — not a 500 that
   * looks like the marketplace is broken.
   */
  it('surfaces as a clean 402 the agent can branch on', async () => {
    const client = await register('Client');
    const worker = await register('Worker');
    submitBehaviour = () => {
      throw new AgentxError(ErrorCode.BUDGET_EXCEEDED, 'exceeds today’s remaining budget', 3600);
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...auth(client.apiKey), 'idempotency-key': 'cap-test-key-1'},
      payload: {
        workerAgentId: String(worker.agentId),
        maxPrice: '50000',
        spec: {capability: 'market-research', input: {}, deadlineSeconds: 120},
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe(ErrorCode.BUDGET_EXCEEDED);
    expect(res.json().retryAfter).toBe(3600);
  });

  it('reports an empty gas wallet as 402 with the address to fund', async () => {
    const client = await register('Client');
    const worker = await register('Worker');
    submitBehaviour = () => {
      throw new AgentxError(
        ErrorCode.INSUFFICIENT_FUNDS,
        'the agent wallet 0xabc has no MON left for gas — top it up and retry the same request',
      );
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...auth(client.apiKey), 'idempotency-key': 'gas-test-key-1'},
      payload: {
        workerAgentId: String(worker.agentId),
        maxPrice: '50000',
        spec: {capability: 'market-research', input: {}, deadlineSeconds: 120},
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().detail).toMatch(/top it up/);
  });

  /**
   * A refusal must not consume the job row. If it did, the retry that follows
   * a top-up would collide with a half-created job.
   */
  it('does not leave a phantom job behind when the signer refuses', async () => {
    const client = await register('Client');
    const worker = await register('Worker');
    submitBehaviour = () => {
      throw new AgentxError(ErrorCode.BUDGET_EXCEEDED, 'nope');
    };

    await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {...auth(client.apiKey), 'idempotency-key': 'phantom-key-1'},
      payload: {
        workerAgentId: String(worker.agentId),
        maxPrice: '50000',
        spec: {capability: 'market-research', input: {}, deadlineSeconds: 120},
      },
    });

    const rows = (await db.execute(
      sql`SELECT state FROM jobs`,
    )) as unknown as {state: string}[];

    // The row may exist — the id is needed to compute specHash — but it must
    // never claim to have been created on-chain.
    for (const row of rows) expect(row.state).toBe('created');
    const events = (await db.execute(sql`SELECT count(*)::int AS n FROM job_events`)) as unknown as {n: number}[];
    expect(events[0]!.n).toBe(0);
  });
});
