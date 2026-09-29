import {describe, expect, it} from 'vitest';
import {AgentxClient, AgentxError, ErrorCode} from '../src/index.js';

/**
 * `@agentx/sdk` — the client every agent imports. It had no tests.
 *
 * Two of the things it decides are about money, not convenience:
 *
 *   - **What is worth retrying.** Retrying a spending cap wastes the agent's
 *     time and the operator's rate limit, and it will never succeed. Retrying
 *     a dropped connection is how a paid job survives a blip.
 *   - **The idempotency key.** It is what stops a retried hire becoming a
 *     second payment, and it is derived here when the caller omits one.
 *
 * Nothing exercised either.
 */

/** A fetch that answers from a script and records what it was asked. */
function fakeFetch(
  script: (call: number, url: string, init?: RequestInit) => {status: number; body: unknown},
) {
  const calls: {url: string; init?: RequestInit}[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({url: String(url), ...(init ? {init} : {})});
    const {status, body} = script(calls.length, String(url), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    });
  };
  return {calls, impl: impl as unknown as typeof fetch};
}

const problem = (code: ErrorCode, detail: string, retryAfter?: number) => ({
  type: `https://agentx.dev/errors/x`,
  title: 'x',
  status: 402,
  code,
  detail,
  ...(retryAfter !== undefined ? {retryAfter} : {}),
});

function client(impl: typeof fetch, over: {maxRetries?: number} = {}) {
  return new AgentxClient({
    baseUrl: 'http://api.test',
    apiKey: 'ax_test',
    chainId: 10143,
    fetchImpl: impl,
    ...(over.maxRetries !== undefined ? {maxRetries: over.maxRetries} : {}),
  });
}

const SPEC = {
  capability: 'market-research',
  input: {question: 'depth?'},
  deadlineSeconds: 120,
} as never;

describe('what the client retries', () => {
  /**
   * A cap is a decision the owner made on-chain. Retrying it cannot succeed,
   * and doing so is how an agent turns one refusal into a rate-limit ban.
   */
  it('never retries a spending cap', async () => {
    const f = fakeFetch(() => ({status: 402, body: problem(ErrorCode.BUDGET_EXCEEDED, 'over the daily cap')}));
    let error: unknown;
    try {
      await client(f.impl).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    } catch (err) {
      error = err;
    }
    expect((error as AgentxError).code).toBe(ErrorCode.BUDGET_EXCEEDED);
    expect(f.calls.length, 'a cap must be attempted exactly once').toBe(1);
  });

  it('never retries a price above the ceiling, or a schema mismatch', async () => {
    for (const code of [ErrorCode.PRICE_ABOVE_MAX, ErrorCode.SCHEMA_MISMATCH, ErrorCode.INVALID_STATE]) {
      const f = fakeFetch(() => ({status: 409, body: problem(code, 'no')}));
      await client(f.impl)
        .hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'})
        .catch(() => undefined);
      expect(f.calls.length, `${code} must not be retried`).toBe(1);
    }
  });

  /** A 500 is the server's problem and may well be gone next time. */
  it('retries a server error and succeeds when it clears', async () => {
    const f = fakeFetch((call) =>
      call < 3
        ? {status: 500, body: {code: 'INVALID_STATE', detail: 'boom'}}
        : {status: 201, body: {jobId: '7', amount: '20000'}},
    );
    const receipt = await client(f.impl).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    expect(receipt.jobId).toBe('7');
    expect(f.calls.length).toBe(3);
  });

  it('gives up after maxRetries and surfaces the last error', async () => {
    const f = fakeFetch(() => ({status: 503, body: {code: 'INVALID_STATE', detail: 'still down'}}));
    let error: unknown;
    try {
      await client(f.impl, {maxRetries: 2}).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AgentxError);
    expect(f.calls.length).toBe(2);
  });

  it('retries a rate limit rather than treating it as fatal', async () => {
    const f = fakeFetch((call) =>
      call === 1
        ? {status: 429, body: {code: 'RATE_LIMITED', detail: 'slow down', retryAfter: 0}}
        : {status: 200, body: {agents: []}},
    );
    await client(f.impl).discover({capability: 'market-research' as never});
    expect(f.calls.length).toBe(2);
  });

  /**
   * A network-level failure is exactly what the idempotency key makes safe to
   * retry — the request may or may not have arrived.
   */
  it('retries a dropped connection', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls < 2) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({agents: []}), {status: 200});
    }) as unknown as typeof fetch;

    await client(impl).discover({});
    expect(calls).toBe(2);
  });
});

describe('the error contract agents branch on', () => {
  it('turns an RFC 7807 problem into a typed code, not a status number', async () => {
    const f = fakeFetch(() => ({status: 409, body: problem(ErrorCode.AGENT_NOT_HIREABLE, 'not on chain yet', 2)}));
    let error: unknown;
    try {
      await client(f.impl).getJob('1');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AgentxError);
    expect((error as AgentxError).code).toBe(ErrorCode.AGENT_NOT_HIREABLE);
    expect((error as AgentxError).retryAfter).toBe(2);
  });

  it('still produces an AgentxError when the body is not a problem document', async () => {
    const f = fakeFetch(() => ({status: 502, body: 'gateway'}));
    let error: unknown;
    try {
      await client(f.impl, {maxRetries: 1}).getJob('1');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AgentxError);
  });
});

describe('the idempotency key', () => {
  /** Without it, a retried hire is a second payment. */
  it('is sent on every hire', async () => {
    const f = fakeFetch(() => ({status: 201, body: {jobId: '1'}}));
    await client(f.impl).hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});

    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
    expect(headers['idempotency-key']!.length).toBeGreaterThanOrEqual(8);
  });

  /**
   * Derived from the request itself, so two identical hires a second apart —
   * almost certainly a retry — collapse into one payment.
   */
  it('is identical for the same worker and spec', async () => {
    const keys: string[] = [];
    const f = fakeFetch((_c, _u, init) => {
      keys.push((init!.headers as Record<string, string>)['idempotency-key']!);
      return {status: 201, body: {jobId: '1'}};
    });
    const c = client(f.impl);
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});

    expect(keys[0]).toBe(keys[1]);
  });

  it('differs when the work differs', async () => {
    const keys: string[] = [];
    const f = fakeFetch((_c, _u, init) => {
      keys.push((init!.headers as Record<string, string>)['idempotency-key']!);
      return {status: 201, body: {jobId: '1'}};
    });
    const c = client(f.impl);
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    await c.hire({
      workerAgentId: 2,
      spec: {...(SPEC as object), input: {question: 'something else'}} as never,
      maxPrice: '50000',
    });

    expect(keys[0]).not.toBe(keys[1]);
  });

  it('differs when the worker differs, for identical work', async () => {
    const keys: string[] = [];
    const f = fakeFetch((_c, _u, init) => {
      keys.push((init!.headers as Record<string, string>)['idempotency-key']!);
      return {status: 201, body: {jobId: '1'}};
    });
    const c = client(f.impl);
    await c.hire({workerAgentId: 2, spec: SPEC, maxPrice: '50000'});
    await c.hire({workerAgentId: 3, spec: SPEC, maxPrice: '50000'});

    expect(keys[0]).not.toBe(keys[1]);
  });

  it('uses a caller-supplied key verbatim, so a restart can be made safe', async () => {
    const f = fakeFetch(() => ({status: 201, body: {jobId: '1'}}));
    await client(f.impl).hire({
      workerAgentId: 2,
      spec: SPEC,
      maxPrice: '50000',
      idempotencyKey: 'my-own-durable-key',
    });
    const headers = f.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('my-own-durable-key');
  });
});

describe('credentials', () => {
  it('browses the marketplace without sending a key', async () => {
    const f = fakeFetch(() => ({status: 200, body: {agents: []}}));
    await client(f.impl).discover({capability: 'market-research' as never});
    expect((f.calls[0]!.init!.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('sends the key for a budget lookup, which is not public', async () => {
    const f = fakeFetch(() => ({status: 200, body: {dailyRemaining: '0'}}));
    await client(f.impl).budget();
    expect((f.calls[0]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer ax_test');
  });
});

describe('awaitResult', () => {
  it('polls until the job reaches a terminal state', async () => {
    const f = fakeFetch((call) => ({
      status: 200,
      body: {jobId: '1', state: call < 3 ? 'accepted' : 'settled'},
    }));
    const job = await client(f.impl).awaitResult('1', {timeoutMs: 5_000, pollMs: 1});
    expect(job.state).toBe('settled');
    expect(f.calls.length).toBe(3);
  });

  it('treats a refund as terminal too', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'refunded'}}));
    const job = await client(f.impl).awaitResult('1', {timeoutMs: 1_000, pollMs: 1});
    expect(job.state).toBe('refunded');
  });

  /**
   * A timeout is not a lost payment — the job still has an on-chain deadline
   * and a permissionless exit. The error has to say which, or a caller will
   * assume the money is gone.
   */
  it('times out with DEADLINE_PASSED and says the job is still recoverable', async () => {
    const f = fakeFetch(() => ({status: 200, body: {jobId: '1', state: 'accepted'}}));
    let error: unknown;
    try {
      await client(f.impl).awaitResult('1', {timeoutMs: 5, pollMs: 1});
    } catch (err) {
      error = err;
    }
    expect((error as AgentxError).code).toBe(ErrorCode.DEADLINE_PASSED);
    expect((error as AgentxError).message).toMatch(/recoverable|expiry/i);
  });
});

describe('query building', () => {
  it('passes discovery filters through and pins the chain', async () => {
    const f = fakeFetch(() => ({status: 200, body: {agents: []}}));
    await client(f.impl).discover({
      capability: 'market-research' as never,
      maxPrice: '50000',
      minScore: 70,
      rank: 'cheapest',
      limit: 5,
    });

    const url = f.calls[0]!.url;
    for (const part of ['capability=market-research', 'maxPrice=50000', 'minScore=70', 'rank=cheapest', 'limit=5', 'chainId=10143']) {
      expect(url).toContain(part);
    }
  });

  it('omits filters that were not given, rather than sending empty ones', async () => {
    const f = fakeFetch(() => ({status: 200, body: {agents: []}}));
    await client(f.impl).discover({});
    expect(f.calls[0]!.url).not.toContain('capability=');
    expect(f.calls[0]!.url).not.toContain('minScore=');
  });
});
