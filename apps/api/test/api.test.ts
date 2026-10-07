import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@agentx/config';
import {sql} from 'drizzle-orm';
import {createDb, closeDb, type Db} from '@agentx/db';
import {buildApp, EventBus} from '../src/app.js';

/**
 * API behaviour, exercised through real HTTP against a real database.
 *
 * `submit` is injected, so no signer, no chain and no network are involved —
 * the chain path is covered by the contract suite and verify-indexer. What is
 * under test here is authorisation, state transitions, idempotency and the
 * error contract, which is exactly where a demo breaks.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';

let app: FastifyInstance;
let db: Db;
let submitted: {kind: string; spend: bigint; idempotencyKey: string}[] = [];

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

beforeAll(async () => {
  db = createDb(DB_URL, {max: 3});
  app = await buildApp({
    db,
    chains: config.chains,
    defaultChainId: 31337,
    bus: new EventBus(),
    submit: async (args) => {
      submitted.push({kind: args.kind, spend: args.spend, idempotencyKey: args.idempotencyKey});
      return {txHash: `0x${'ab'.repeat(32)}`, chainJobId: String(submitted.length)};
    },
  });
});

afterAll(async () => {
  await app.close();
  await closeDb(db);
});

beforeEach(async () => {
  submitted = [];
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments RESTART IDENTITY CASCADE`,
  );
});

async function register(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: {
      name: 'ResearchBot',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: '0x' + '11'.repeat(20),
      ownerAddress: '0x' + '22'.repeat(20),
      ...over,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {agentId: number; apiKey: string};

  // Stand in for the indexer observing ERC-8004 `Registered`. Without a
  // chain_agent_id the API refuses to hire, because sending a database serial
  // where the contract expects an ERC-8004 id pays a different agent.
  await db.execute(sql`UPDATE agents SET chain_agent_id = ${body.agentId + 1000} WHERE id = ${body.agentId}`);
  return body;
}

/** Register an agent that the indexer has NOT yet seen on-chain. */
async function registerUnconfirmed(over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: {
      name: 'Unconfirmed',
      capabilities: ['market-research'],
      pricePerTask: '20000',
      walletAddress: '0x' + '99'.repeat(20),
      ownerAddress: '0x' + '88'.repeat(20),
      ...over,
    },
  });
  return res.json() as {agentId: number; apiKey: string};
}

describe('agent registration', () => {
  it('issues an API key exactly once and never stores it', async () => {
    const {agentId, apiKey} = await register();
    expect(apiKey).toMatch(/^ax_/);

    const rows = await db.execute(sql`SELECT key_hash FROM api_keys WHERE agent_id = ${agentId}`);
    const stored = (rows as unknown as {key_hash: string}[])[0]!.key_hash;
    expect(stored).not.toContain(apiKey);
    expect(stored.startsWith('sha256$')).toBe(true);
  });

  /**
   * A uniqueness conflict is the caller's to act on — 409, naming what clashed —
   * not a 500 telling them to retry what can never succeed. drizzle 0.45 moved
   * the Postgres error to `cause`, which silently broke this until a test
   * pinned it.
   */
  it('answers a duplicate registration with 409 ALREADY_EXISTS, not a 500', async () => {
    await register();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: {
        name: 'Duplicate',
        capabilities: ['market-research'],
        pricePerTask: '20000',
        walletAddress: '0x' + '11'.repeat(20),
        ownerAddress: '0x' + '22'.repeat(20),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ALREADY_EXISTS');
  });

  it('rejects a capability that is not kebab-case', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: {
        name: 'Bad',
        capabilities: ['Market Research'],
        pricePerTask: '1',
        walletAddress: '0x' + '33'.repeat(20),
        ownerAddress: '0x' + '44'.repeat(20),
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SCHEMA_MISMATCH');
  });

  it('rejects a price that is not an integer string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: {
        name: 'Bad',
        capabilities: ['x-y'],
        pricePerTask: '0.02',
        walletAddress: '0x' + '55'.repeat(20),
        ownerAddress: '0x' + '66'.repeat(20),
      },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('discovery', () => {
  it('is browsable without credentials', async () => {
    await register();
    const res = await app.inject({method: 'GET', url: '/v1/agents?capability=market-research'});
    expect(res.statusCode).toBe(200);
    expect(res.json().agents).toHaveLength(1);
  });

  it('states the chain on every response', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/agents'});
    expect(res.json().chainId).toBe(31337);
    expect(res.json().network).toBe('Anvil Local');
  });

  it('formats prices rather than making the client do decimals', async () => {
    await register();
    const {agents} = await app.inject({method: 'GET', url: '/v1/agents'}).then((r) => r.json());
    expect(agents[0].priceDisplay).toBe('0.02 MockUSDC');
  });

  it('filters by capability and by maxPrice', async () => {
    await register({name: 'Cheap', pricePerTask: '10000', walletAddress: '0x' + 'aa'.repeat(20)});
    await register({name: 'Dear', pricePerTask: '90000', walletAddress: '0x' + 'bb'.repeat(20)});

    const cheap = await app.inject({method: 'GET', url: '/v1/agents?maxPrice=20000'}).then((r) => r.json());
    expect(cheap.agents.map((a: {name: string}) => a.name)).toEqual(['Cheap']);

    const none = await app
      .inject({method: 'GET', url: '/v1/agents?capability=does-not-exist'})
      .then((r) => r.json());
    expect(none.agents).toHaveLength(0);
  });

  it('ranks cheapest-first only when asked to', async () => {
    await register({name: 'Cheap', pricePerTask: '10000', walletAddress: '0x' + 'cc'.repeat(20)});
    await register({name: 'Dear', pricePerTask: '90000', walletAddress: '0x' + 'dd'.repeat(20)});

    const cheapest = await app.inject({method: 'GET', url: '/v1/agents?rank=cheapest'}).then((r) => r.json());
    expect(cheapest.agents[0].name).toBe('Cheap');
  });

  it('reports an unproven agent as 50, not 0 and not 100', async () => {
    await register();
    const {agents} = await app.inject({method: 'GET', url: '/v1/agents'}).then((r) => r.json());
    expect(agents[0].score).toBe(50);
    expect(agents[0].successRate).toBeNull();
  });
});

describe('hiring', () => {
  async function twoAgents() {
    const client = await register({name: 'Client', walletAddress: '0x' + 'e1'.repeat(20)});
    const worker = await register({name: 'Worker', walletAddress: '0x' + 'e2'.repeat(20)});
    return {client, worker};
  }

  const hire = (key: string, workerAgentId: number, over: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${key}`, 'idempotency-key': 'key-0000001'},
      payload: {
        workerAgentId: String(workerAgentId),
        spec: {capability: 'market-research', input: {}},
        maxPrice: '50000',
        ...over,
      },
    });

  /** Paying up front is a bet on the worker; it is only offered on a record. */
  const proven = (agentId: number, score = 80) =>
    db.execute(sql`UPDATE agent_stats SET score = ${score}, completed = 30 WHERE agent_id = ${agentId}`);

  /**
   * Reads are public by design — a job is shareable evidence — so its id is
   * the only thing between a job and a stranger. v1 used the serial id, and
   * `GET /v1/jobs/1`, `/2`, `/3` walked every job in the system.
   */
  it('names a job by an unguessable public id, and a serial id names nothing', async () => {
    const {client, worker} = await twoAgents();
    const {jobId} = (await hire(client.apiKey, worker.agentId)).json();
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect((await app.inject({url: `/v1/jobs/${jobId}`})).statusCode).toBe(200);

    for (const guess of ['1', '2', 'NaN', '../1']) {
      const res = await app.inject({url: `/v1/jobs/${guess}`});
      expect(res.statusCode, guess).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
    expect((await app.inject({url: '/v1/runs/1'})).statusCode).toBe(404);
  });

  /**
   * v2's escrow refuses any job below `minJobAmount`, so a worker priced below
   * it cannot be hired at all. Said here, before a transaction is paid for
   * and reverts.
   */
  it('refuses to hire a worker priced below the escrow minimum, before submitting', async () => {
    const client = await register();
    const worker = await register({
      name: 'Cheap',
      walletAddress: '0x' + '44'.repeat(20),
      pricePerTask: '5000',
    });
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
    expect(res.json().detail).toMatch(/below the escrow minimum/);
    expect(submitted).toHaveLength(0);
  });

  it('takes the fast path below the threshold and says so', async () => {
    const {client, worker} = await twoAgents();
    await proven(worker.agentId);
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.statusCode).toBe(201);

    const body = res.json();
    // fastPathMax is 0.03; the price is 0.02.
    expect(body.path).toBe('direct');
    expect(body.amountDisplay).toBe('0.02 MockUSDC');
    expect(body.explorerUrl).toBeTruthy();
    expect(submitted[0]!.kind).toBe('directPay');
  });

  /**
   * `fastPathMinScore` (70) was configured, documented, deployed — and read by
   * nothing. So every cheap hire of an agent with no history at all paid up
   * front, with no recourse if the work was bad. The fast path trades
   * protection for speed, and only a record earns that trade.
   */
  it('uses escrow for an unproven worker, however cheap', async () => {
    const {client, worker} = await twoAgents();
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.json().path).toBe('escrow');
    expect(submitted[0]!.kind).toBe('createJob');
  });

  it('uses escrow for a worker just under the score bar', async () => {
    const {client, worker} = await twoAgents();
    await proven(worker.agentId, 69);
    expect((await hire(client.apiKey, worker.agentId)).json().path).toBe('escrow');
  });

  it('still honours a client that asks for the fast path explicitly', async () => {
    const {client, worker} = await twoAgents();
    expect((await hire(client.apiKey, worker.agentId, {path: 'direct'})).json().path).toBe('direct');
  });

  it('uses escrow above the threshold', async () => {
    const client = await register({name: 'C', walletAddress: '0x' + 'f1'.repeat(20)});
    const worker = await register({name: 'W', pricePerTask: '90000', walletAddress: '0x' + 'f2'.repeat(20)});
    const res = await hire(client.apiKey, worker.agentId, {maxPrice: '100000'});
    expect(res.json().path).toBe('escrow');
    expect(submitted[0]!.kind).toBe('createJob');
  });

  /**
   * A retried hire used to INSERT A NEW JOB each time. The signer correctly
   * returned the original transaction — so nothing was paid twice — but the
   * retry's response carried a new job id: the caller then waited on a job no
   * transaction backed, and the worker was offered the same paid-once work a
   * second time. Found by a live end-to-end run, which counted two rows.
   */
  it('returns the original job for a retried hire instead of creating another', async () => {
    const {client, worker} = await twoAgents();
    const first = (await hire(client.apiKey, worker.agentId)).json();
    const retry = await hire(client.apiKey, worker.agentId);

    expect(retry.statusCode).toBe(201);
    expect(retry.json().jobId).toBe(first.jobId);
    expect(retry.json().txHash).toBe(first.txHash);
    const rows = (await db.execute(sql`SELECT count(*)::int AS n FROM jobs`)) as unknown as {n: number}[];
    expect(rows[0]!.n).toBe(1);
    expect(submitted).toHaveLength(1);
  });

  it('refuses a reused key for a different hire, rather than guessing which was meant', async () => {
    const {client, worker} = await twoAgents();
    await hire(client.apiKey, worker.agentId);
    const other = await hire(client.apiKey, worker.agentId, {
      spec: {capability: 'market-research', input: {q: 'other'}},
    });

    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses without an Idempotency-Key', async () => {
    const {client, worker} = await twoAgents();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.apiKey}`},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'x-y', input: {}},
        maxPrice: '50000',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses when the price is above maxPrice', async () => {
    const {client, worker} = await twoAgents();
    const res = await hire(client.apiKey, worker.agentId, {maxPrice: '1'});
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PRICE_ABOVE_MAX');
    expect(res.json().detail).toContain('0.02 MockUSDC');
  });

  it('refuses to let an agent hire itself', async () => {
    const {client} = await twoAgents();
    const res = await hire(client.apiKey, client.agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_STATE');
  });

  it('refuses an inactive worker', async () => {
    const {client, worker} = await twoAgents();
    await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${worker.agentId}`,
      headers: {authorization: `Bearer ${worker.apiKey}`},
      payload: {active: false},
    });
    const res = await hire(client.apiKey, worker.agentId);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
  });

  it('refuses to hire an agent the indexer has not confirmed on-chain', async () => {
    const {client} = await twoAgents();
    const ghost = await registerUnconfirmed();
    const res = await hire(client.apiKey, ghost.agentId);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_NOT_HIREABLE');
    expect(res.json().detail).toContain('ERC-8004');
  });

  it('rejects an unknown API key', async () => {
    const {worker} = await twoAgents();
    const res = await hire('ax_not_a_real_key', worker.agentId);
    // 401, not the 409 CHAIN_MISMATCH it used to be: nothing about a bad key
    // is a chain, and a client told "wrong chain" goes looking for a network
    // problem instead of a credential one.
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });
});

describe('job lifecycle', () => {
  async function escrowJob() {
    const client = await register({name: 'C', walletAddress: '0x' + 'a1'.repeat(20)});
    const worker = await register({name: 'W', pricePerTask: '90000', walletAddress: '0x' + 'a2'.repeat(20)});
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: {authorization: `Bearer ${client.apiKey}`, 'idempotency-key': 'lifecycle-1'},
      payload: {
        workerAgentId: String(worker.agentId),
        spec: {capability: 'market-research', input: {q: 'depth'}},
        maxPrice: '100000',
      },
    });
    return {client, worker, jobId: res.json().jobId as string};
  }

  const post = (url: string, key: string, payload: Record<string, unknown> = {}) =>
    app.inject({method: 'POST', url, headers: {authorization: `Bearer ${key}`}, payload});

  it('runs accept -> result -> approve', async () => {
    const {client, worker, jobId} = await escrowJob();

    expect((await post(`/v1/jobs/${jobId}/accept`, worker.apiKey)).statusCode).toBe(200);
    expect(
      (
        await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
          output: {summary: 'deep'},
          producedAt: new Date().toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    expect((await post(`/v1/jobs/${jobId}/approve`, client.apiKey)).statusCode).toBe(200);

    const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
    expect(job.state).toBe('settled');
    // `result` is the worker's OUTPUT, not the delivery envelope. This used
    // to read `job.result.output.summary`, which encoded the envelope shape
    // and is part of why the mismatch survived: the worker, the API and the
    // orchestrator all check `result` against the job's outputSchema, and an
    // envelope fails that check however good the work was.
    expect(job.result.summary).toBe('deep');
  });

  it('refuses a transition from the wrong state', async () => {
    const {client, jobId} = await escrowJob();
    const res = await post(`/v1/jobs/${jobId}/approve`, client.apiKey);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('INVALID_STATE');
    expect(res.json().detail).toContain('needs "submitted"');
  });

  it('lets only the worker accept and only the client approve', async () => {
    const {client, worker, jobId} = await escrowJob();

    const notYours = await post(`/v1/jobs/${jobId}/accept`, client.apiKey);
    expect(notYours.statusCode).toBe(403);
    expect(notYours.json().code).toBe('FORBIDDEN');
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {ok: true},
      producedAt: new Date().toISOString(),
    });
    // The worker would love to approve its own work.
    expect((await post(`/v1/jobs/${jobId}/approve`, worker.apiKey)).statusCode).toBe(403);
  });

  it('rejects a result that fails schema validation before storing it', async () => {
    const {worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);

    const res = await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {nonsense: true});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SCHEMA_MISMATCH');

    const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
    expect(job.result).toBeNull();
    expect(job.state).toBe('accepted');
  });

  /**
   * A worker that will not take a job says so, with its reason. Off-chain and
   * free: the job stays `created`, and the client — told at once instead of
   * after its accept window — cancels and hires someone else.
   */
  describe('a decline', () => {
    it('is recorded with its reason and shown on the job', async () => {
      const {worker, jobId} = await escrowJob();
      const res = await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'needs a private API key'});
      expect(res.statusCode).toBe(200);
      expect(res.json().declined.reason).toBe('needs a private API key');

      const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
      expect(job.state).toBe('created');
      expect(job.declined).toMatchObject({reason: 'needs a private API key'});
      expect(job.events.map((e: {kind: string}) => e.kind)).toContain('job.declined');
    });

    it('is shown as null on a job nobody declined', async () => {
      const {jobId} = await escrowJob();
      const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
      expect(job.declined).toBeNull();
    });

    it('comes only from the hired worker', async () => {
      const {client, jobId} = await escrowJob();
      const stranger = await register({name: 'S', walletAddress: '0x' + 'a3'.repeat(20)});
      expect((await post(`/v1/jobs/${jobId}/decline`, client.apiKey, {reason: 'x'})).statusCode).toBe(403);
      expect((await post(`/v1/jobs/${jobId}/decline`, stranger.apiKey, {reason: 'x'})).statusCode).toBe(403);
      const anonymous = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobId}/decline`,
        payload: {reason: 'x'},
      });
      expect(anonymous.statusCode).toBe(401);
    });

    it('is refused once the worker has accepted', async () => {
      const {worker, jobId} = await escrowJob();
      await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
      const res = await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'changed my mind'});
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVALID_STATE');
    });

    it('needs a reason, and keeps the first one', async () => {
      const {worker, jobId} = await escrowJob();
      expect((await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {})).statusCode).toBe(422);
      await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'first'});
      const again = await post(`/v1/jobs/${jobId}/decline`, worker.apiKey, {reason: 'second'});
      expect(again.statusCode).toBe(200);
      expect(again.json().declined.reason).toBe('first');

      const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
      expect(job.events.filter((e: {kind: string}) => e.kind === 'job.declined')).toHaveLength(1);
    });
  });

  it('records an event for every transition', async () => {
    const {client, worker, jobId} = await escrowJob();
    await post(`/v1/jobs/${jobId}/accept`, worker.apiKey);
    await post(`/v1/jobs/${jobId}/result`, worker.apiKey, {
      output: {},
      producedAt: new Date().toISOString(),
    });
    await post(`/v1/jobs/${jobId}/approve`, client.apiKey);

    const job = await app.inject({method: 'GET', url: `/v1/jobs/${jobId}`}).then((r) => r.json());
    expect(job.events.map((e: {kind: string}) => e.kind)).toEqual([
      'job.created',
      'job.accepted',
      'job.submitted',
      'job.settled',
    ]);
  });
});

describe('the error contract agents depend on', () => {
  it('always returns a machine-readable code and a trace id', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/jobs/999999'});
    const body = res.json();
    expect(body.code).toBeTruthy();
    expect(body.type).toContain('agentx.dev/errors/');
    expect(body.traceId).toBeTruthy();
    expect(res.headers['x-trace-id']).toBe(body.traceId);
  });

  it('uses problem+json so a client can tell an error from a result', async () => {
    const res = await app.inject({method: 'GET', url: '/v1/nope'});
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('reports which chains are live on /health', async () => {
    const health = await app.inject({method: 'GET', url: '/health'}).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.chains[0].chainId).toBe(31337);
    expect(health.chains[0].escrow).toMatch(/^0x/);
  });
});
