import {EventEmitter} from 'node:events';
import Fastify from 'fastify';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  EnvError,
  bearerMatches,
  createMetrics,
  env,
  installShutdown,
  loadEnv,
  registerHealth,
  registerMetrics,
  serviceOptions,
} from '../src/index.js';

describe('loadEnv', () => {
  const schema = z.object({
    DATABASE_URL: env.postgresUrl(),
    PORT: env.port(8080),
    CORS_ORIGINS: env.csv(),
    TRUST_PROXY: env.flag(),
  });

  it('applies defaults and coerces', () => {
    const e = loadEnv(schema, {
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      CORS_ORIGINS: 'https://a, https://b',
    });
    expect(e).toEqual({
      DATABASE_URL: 'postgres://u:p@h:5432/d',
      PORT: 8080,
      CORS_ORIGINS: ['https://a', 'https://b'],
      TRUST_PROXY: false,
    });
  });

  /** A typo'd port used to become NaN and fail at listen time, far from the cause. */
  it('refuses to start, naming EVERY problem at once', () => {
    let err: unknown;
    try {
      loadEnv(schema, {PORT: 'eighty'});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvError);
    const issues = (err as EnvError).issues.join('\n');
    expect(issues).toMatch(/DATABASE_URL/);
    expect(issues).toMatch(/PORT/);
  });

  /** `.env` files set unused variables to ''; that must mean "unset", not "invalid". */
  it('treats an empty string as unset', () => {
    const e = loadEnv(schema, {DATABASE_URL: 'postgres://x', PORT: ''});
    expect(e.PORT).toBe(8080);
  });
});

describe('request ids', () => {
  it('honours an incoming x-request-id and generates a UUID otherwise', async () => {
    const app = Fastify(serviceOptions());
    app.get('/', async (req) => ({id: req.id}));
    const given = (await app.inject({url: '/', headers: {'x-request-id': 'trace-123'}})).json();
    const made = (await app.inject({url: '/'})).json();
    expect(given.id).toBe('trace-123');
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});

describe('health and readiness', () => {
  it('is live while not ready, and says which dependency failed', async () => {
    const app = Fastify();
    registerHealth(app, {
      checks: {
        database: async () => {
          throw new Error('connection refused');
        },
        rpc: async () => 1,
      },
    });
    expect((await app.inject({url: '/health'})).statusCode).toBe(200);
    const ready = await app.inject({url: '/ready'});
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks).toEqual({
      database: {ok: false, error: 'connection refused'},
      rpc: {ok: true},
    });
    await app.close();
  });

  it('times out a dependency that never answers', async () => {
    const app = Fastify();
    registerHealth(app, {checks: {slow: () => new Promise(() => {})}, timeoutMs: 50});
    const ready = await app.inject({url: '/ready'});
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.slow.error).toMatch(/did not answer/);
    await app.close();
  });
});

describe('metrics', () => {
  it('records request durations by route template and guards /metrics with a token', async () => {
    const app = Fastify();
    const metrics = createMetrics('test');
    registerMetrics(app, metrics, {token: 's3cret'});
    app.get('/jobs/:id', async () => ({}));
    await app.inject({url: '/jobs/abc'});
    await app.inject({url: '/jobs/def'});

    expect((await app.inject({url: '/metrics'})).statusCode).toBe(401);
    const body = (await app.inject({url: '/metrics', headers: {authorization: 'Bearer s3cret'}})).body;
    // One series for the template, not one per id.
    expect(body).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/jobs\/:id"[^}]*\} 2/);
    expect(body).not.toMatch(/\/jobs\/abc/);
    await app.close();
  });

  it('compares the token in constant time and treats an unset token as open', () => {
    expect(bearerMatches('Bearer abc', 'abc')).toBe(true);
    expect(bearerMatches('Bearer abd', 'abc')).toBe(false);
    expect(bearerMatches(undefined, 'abc')).toBe(false);
    expect(bearerMatches(undefined, undefined)).toBe(true);
  });
});

describe('shutdown', () => {
  const quiet = {info: () => {}, error: () => {}, fatal: () => {}};

  it('runs closers in order on SIGTERM, once, and exits 0', async () => {
    const proc = new EventEmitter();
    const order: string[] = [];
    const exits: number[] = [];
    const handle = installShutdown({
      logger: quiet,
      process: proc,
      exit: (c) => exits.push(c),
      closers: [
        ['http', async () => order.push('http')],
        ['db', async () => order.push('db')],
      ],
    });
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    await handle.shutdown('again');
    expect(order).toEqual(['http', 'db']);
    expect(exits).toEqual([0]);
    expect(handle.signal.aborted).toBe(true);
  });

  it('keeps closing when one closer fails, and exits 1 on an unhandled rejection', async () => {
    const proc = new EventEmitter();
    const order: string[] = [];
    const exits: number[] = [];
    const handle = installShutdown({
      logger: quiet,
      process: proc,
      exit: (c) => exits.push(c),
      closers: [
        [
          'http',
          async () => {
            throw new Error('boom');
          },
        ],
        ['db', async () => order.push('db')],
      ],
    });
    proc.emit('unhandledRejection', new Error('lost promise'));
    await handle.shutdown('x');
    expect(order).toEqual(['db']);
    expect(exits).toEqual([1]);
  });
});
