import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@agentx/config';
import {createDb, closeDb, type Db} from '@agentx/db';
import {createMetrics} from '@agentx/service';
import {buildApp, EventBus} from '../src/app.js';
import {streamEvents} from '../src/events.js';

/**
 * Production hardening of the HTTP surface: headers, readiness, metrics,
 * bounded streams, and a shutdown that does not wait on them.
 */
const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

let db: Db;
beforeAll(() => {
  db = createDb(DB_URL, {max: 2});
});
afterAll(async () => {
  await closeDb(db);
});

const build = (over: Record<string, unknown> = {}) =>
  buildApp({
    db,
    chains: config.chains as Record<number, never>,
    defaultChainId: 31337,
    submit: async () => ({txHash: '0x'}),
    ...over,
  });

describe('the HTTP surface', () => {
  it('sends security headers that forbid rendering or framing a response', async () => {
    const app = await build();
    const res = await app.inject({url: '/health'});
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    await app.close();
  });

  it('is live while not ready, and names the dependency that is down', async () => {
    const app = await build({
      readiness: {
        database: async () => 1,
        signer: async () => {
          throw new Error('connection refused');
        },
      },
    });
    expect((await app.inject({url: '/health'})).statusCode).toBe(200);
    const ready = await app.inject({url: '/ready'});
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.signer).toEqual({ok: false, error: 'connection refused'});
    await app.close();
  });

  it('serves request-duration metrics by route template', async () => {
    const app = await build({metrics: createMetrics('api-test')});
    await app.inject({url: '/v1/jobs/00000000-0000-4000-8000-000000000000'});
    const body = (await app.inject({url: '/metrics'})).body;
    expect(body).toMatch(/route="\/v1\/jobs\/:id"/);
    await app.close();
  });

  it('refuses a malformed list limit with 422, not a 500 from Postgres', async () => {
    const app = await build();
    const res = await app.inject({url: '/v1/runs?limit=abc', headers: {authorization: 'Bearer x'}});
    expect(res.statusCode).not.toBe(500);
    await app.close();
  });
});

describe('server-sent event streams', () => {
  async function server(bus: EventBus): Promise<{app: FastifyInstance; url: string}> {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.get('/s', async (_req, reply) => {
      streamEvents(reply, bus, 1);
      return reply;
    });
    app.addHook('preClose', async () => bus.closeAll());
    await app.listen({port: 0, host: '127.0.0.1'});
    return {app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/s`};
  }

  it('refuses a stream beyond the cap with 503, rather than holding sockets without limit', async () => {
    const bus = new EventBus(1);
    const {app, url} = await server(bus);
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const second = await fetch(url);
    expect(second.status).toBe(503);
    expect(bus.streamCount).toBe(1);
    await first.body?.cancel();
    await app.close();
  });

  /**
   * Node holds response headers until the first write. With nothing to replay
   * and nothing published yet, v1's stream sent NO response until the first
   * heartbeat — a client watching a quiet run waited 25 s to be connected.
   */
  it('answers a new subscriber at once, even when there is nothing to send yet', async () => {
    const bus = new EventBus();
    const {app, url} = await server(bus);
    const started = Date.now();
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    await res.body?.cancel();
    await app.close();
  });

  /** v1 had no way to end a stream, so a deploy waited out its full shutdown timeout. */
  it('ends open streams on close, so shutdown does not wait on them', async () => {
    const bus = new EventBus();
    const {app, url} = await server(bus);
    const res = await fetch(url);
    expect(bus.streamCount).toBe(1);

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(bus.streamCount).toBe(0);
    await res.body?.cancel().catch(() => undefined);
  });
});
