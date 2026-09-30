import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '@agentx/config';
import {createDb, closeDb, type Db} from '@agentx/db';
import {buildApp, EventBus} from '../src/app.js';

/**
 * The interface is served from one origin and the API from another — Vercel
 * and Railway in production, two ports locally. The API sent no CORS headers
 * at all, so a browser refused every response: the first time the interface
 * was opened in a real browser, every page said "API unreachable". No test
 * noticed, because no test runs in a browser.
 *
 * Auth is a bearer key, never a cookie, so allowing other origins without
 * credentials gives a hostile page nothing it could not already do with curl.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';
const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

let db: Db;
let open: FastifyInstance;
let pinned: FastifyInstance;

beforeAll(async () => {
  db = createDb(DB_URL, {max: 2});
  const base = {
    db,
    chains: config.chains as Record<number, never>,
    defaultChainId: 31337,
    bus: new EventBus(),
    submit: async () => ({txHash: '0x'}),
  };
  open = await buildApp(base);
  pinned = await buildApp({...base, corsOrigins: ['https://agentx.example']});
});

afterAll(async () => {
  await open.close();
  await pinned.close();
  await closeDb(db);
});

const UI = 'http://127.0.0.1:3117';

describe('a browser on another origin', () => {
  it('can read the API', async () => {
    const res = await open.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  it('may send the headers an agent needs, on a preflight', async () => {
    const res = await open.inject({
      method: 'OPTIONS',
      url: '/v1/jobs',
      headers: {
        origin: UI,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
    for (const h of ['authorization', 'content-type', 'idempotency-key']) expect(allowed).toContain(h);
  });

  it('never allows credentials, which is what makes allowing origins safe', async () => {
    const res = await open.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('can see the trace id, so a failed request can be reported', async () => {
    const res = await open.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(String(res.headers['access-control-expose-headers']).toLowerCase()).toContain('x-trace-id');
  });

  it('can be pinned to named origins', async () => {
    const other = await pinned.inject({method: 'GET', url: '/v1/network', headers: {origin: UI}});
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const ours = await pinned.inject({
      method: 'GET',
      url: '/v1/network',
      headers: {origin: 'https://agentx.example'},
    });
    expect(ours.headers['access-control-allow-origin']).toBe('https://agentx.example');
  });
});
