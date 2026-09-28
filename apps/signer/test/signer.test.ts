import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import {fileURLToPath} from 'node:url';
import {encodeAbiParameters, toFunctionSelector, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sql} from 'drizzle-orm';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb, closeDb, type Db} from '@agentx/db';
import {AgentxError, ErrorCode} from '@agentx/shared';
import {SignerService} from '../src/signer.js';

/**
 * The signer, which is the only process in this system that holds a key.
 *
 * It had no tests. Everything it does — refusing a spend over the cap,
 * refusing to broadcast without gas, never reusing a nonce, returning the
 * original hash for a retry — is either custody or the thing that stops a
 * retry becoming a second payment, and none of it was covered.
 *
 * It builds its own RPC client from `chain.rpcUrl`, so rather than changing
 * production code to suit a test, these point that URL at a real JSON-RPC
 * server we control. That exercises the actual viem path: fee estimation,
 * nonce fetch, contract reads and broadcast, with the responses chosen per
 * test.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';

/** Anvil account #0 — a well-known test key, never used on a real network. */
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const ACCOUNT = privateKeyToAccount(TEST_KEY);

const TX_HASH = `0x${'ab'.repeat(32)}`;

/** What the fake chain currently says. Each test sets what it needs. */
interface ChainState {
  balanceWei: bigint;
  nonce: number;
  perTaskCap: bigint;
  dailyCap: bigint;
  dailyRemaining: bigint;
  dayStart: bigint;
  /** When set, eth_sendRawTransaction fails with this message. */
  broadcastError?: string;
  broadcasts: number;
}

let state: ChainState;
let server: Server;
let rpcUrl: string;
let db: Db;

function reset(): ChainState {
  return {
    balanceWei: 10n ** 18n,
    nonce: 4,
    perTaskCap: 100_000n,
    dailyCap: 500_000n,
    dailyRemaining: 400_000n,
    dayStart: BigInt(Math.floor(Date.now() / 1000)),
    broadcasts: 0,
  };
}

const uint = (v: bigint) => encodeAbiParameters([{type: 'uint256'}], [v]);

const SELECTORS = {
  dailyRemaining: toFunctionSelector('function dailyRemaining() view returns (uint128)'),
  dayStart: toFunctionSelector('function dayStart() view returns (uint64)'),
};

/** A JSON-RPC server that answers only what viem asks of this code path. */
function rpc(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0x7a69';
    case 'eth_getBalance':
      return `0x${state.balanceWei.toString(16)}`;
    case 'eth_getTransactionCount':
      return `0x${state.nonce.toString(16)}`;
    case 'eth_gasPrice':
      return '0x3b9aca00';
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00';
    case 'eth_estimateGas':
      return '0x5208';
    case 'eth_blockNumber':
      return '0x1';
    case 'eth_getBlockByNumber':
      return {number: '0x1', baseFeePerGas: '0x3b9aca00', timestamp: '0x1', hash: `0x${'11'.repeat(32)}`};
    case 'eth_call': {
      // Which AgentAccount getter is being read, by selector.
      //
      // COMPUTED, not written down from memory. Hard-coded guesses here fell
      // through to the policy() branch, so a call asking for the remaining
      // daily budget was answered with the per-task cap — and the test
      // reported the signer accepting a spend it had actually never been
      // asked about. A stub that answers the wrong question convincingly is
      // worse than one that fails.
      const data = String((params[0] as {data?: string}).data ?? '');
      if (data.startsWith(SELECTORS.dailyRemaining)) return uint(state.dailyRemaining);
      if (data.startsWith(SELECTORS.dayStart)) return uint(state.dayStart);
      // policy() -> (uint128 perTaskCap, uint128 dailyCap, bool allowlistOnly)
      return encodeAbiParameters(
        [{type: 'uint128'}, {type: 'uint128'}, {type: 'bool'}],
        [state.perTaskCap, state.dailyCap, false],
      );
    }
    case 'eth_sendRawTransaction':
      if (state.broadcastError) throw new Error(state.broadcastError);
      state.broadcasts++;
      return TX_HASH;
    default:
      return null;
  }
}

beforeAll(async () => {
  state = reset();
  db = createDb(DB_URL, {max: 3});

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body) as {id: number; method: string; params: unknown[]};
      res.setHeader('content-type', 'application/json');
      try {
        res.end(JSON.stringify({jsonrpc: '2.0', id: parsed.id, result: rpc(parsed.method, parsed.params ?? [])}));
      } catch (err) {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            error: {code: -32000, message: (err as Error).message},
          }),
        );
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as {port: number}).port;
  rpcUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeDb(db);
});

beforeEach(async () => {
  state = reset();
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events, signer_txs RESTART IDENTITY CASCADE`,
  );
});

const baseConfig = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});

function makeSigner(over: {gasFloorWei?: bigint; withKey?: boolean} = {}): SignerService {
  const chain = {...baseConfig.chain(31337), rpcUrl} as ReturnType<typeof baseConfig.chain>;
  return new SignerService({
    db,
    chain,
    abis: loadAbis() as never,
    keys: {
      accountFor: async () => (over.withKey === false ? null : ACCOUNT),
    } as never,
    ...(over.gasFloorWei !== undefined ? {gasFloorWei: over.gasFloorWei} : {}),
  });
}

/** An agent row whose wallet is the account the signer will use. */
async function anAgent(): Promise<number> {
  const rows = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
        VALUES (31337, ${ACCOUNT.address}, ${ACCOUNT.address}, 'Payer', 20000) RETURNING id`,
  )) as unknown as {id: number}[];
  return rows[0]!.id;
}

const request = (agentId: number, over: Partial<{spend: bigint; idempotencyKey: string; chainId: number}> = {}) => ({
  agentId,
  chainId: over.chainId ?? 31337,
  target: ('0x' + '22'.repeat(20)) as Hex,
  data: '0xdeadbeef' as Hex,
  spend: over.spend ?? 20_000n,
  idempotencyKey: over.idempotencyKey ?? `key-${Math.random()}`,
});

async function expectRefusal(promise: Promise<unknown>, code: ErrorCode): Promise<AgentxError> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error, 'the signer accepted a request it should have refused').toBeInstanceOf(AgentxError);
  expect((error as AgentxError).code).toBe(code);
  return error as AgentxError;
}

describe('what the signer refuses', () => {
  it('refuses a request for a chain it does not serve', async () => {
    const id = await anAgent();
    await expectRefusal(makeSigner().sign(request(id, {chainId: 143})), ErrorCode.CHAIN_MISMATCH);
    expect(state.broadcasts).toBe(0);
  });

  it('refuses when there is no signing key for the agent', async () => {
    const id = await anAgent();
    await expectRefusal(
      makeSigner({withKey: false}).sign(request(id)),
      ErrorCode.AGENT_NOT_HIREABLE,
    );
    expect(state.broadcasts).toBe(0);
  });

  /**
   * Refusing beats broadcasting a transaction that will fail and still
   * consume a nonce — a consumed nonce with no result blocks everything
   * behind it.
   */
  it('refuses to broadcast below the gas floor', async () => {
    const id = await anAgent();
    state.balanceWei = 1n;
    await expectRefusal(makeSigner().sign(request(id)), ErrorCode.INSUFFICIENT_FUNDS);
    expect(state.broadcasts).toBe(0);
  });

  it('refuses a spend above the per-task cap', async () => {
    const id = await anAgent();
    state.perTaskCap = 10_000n;
    await expectRefusal(makeSigner().sign(request(id, {spend: 20_000n})), ErrorCode.BUDGET_EXCEEDED);
    expect(state.broadcasts).toBe(0);
  });

  it('refuses a spend above what is left today, and says when it resets', async () => {
    const id = await anAgent();
    state.dailyRemaining = 5_000n;
    state.dayStart = BigInt(Math.floor(Date.now() / 1000) - 3600);

    const err = await expectRefusal(
      makeSigner().sign(request(id, {spend: 20_000n})),
      ErrorCode.BUDGET_EXCEEDED,
    );
    // The contract's window rolls 24h from dayStart, so ~23h remain.
    expect(err.retryAfter).toBeGreaterThan(22 * 3600);
    expect(err.retryAfter).toBeLessThanOrEqual(23 * 3600);
    expect(state.broadcasts).toBe(0);
  });

  it('allows a spend exactly at the cap', async () => {
    const id = await anAgent();
    state.perTaskCap = 20_000n;
    const result = await makeSigner().sign(request(id, {spend: 20_000n}));
    expect(result.txHash).toBe(TX_HASH);
  });
});

describe('signing, once', () => {
  it('broadcasts and records the nonce and hash', async () => {
    const id = await anAgent();
    const result = await makeSigner().sign(request(id, {idempotencyKey: 'once-1'}));

    expect(result).toMatchObject({txHash: TX_HASH, nonce: 4, replayed: false});
    const rows = (await db.execute(
      sql`SELECT status, nonce, tx_hash FROM signer_txs WHERE idempotency_key = 'once-1'`,
    )) as unknown as {status: string; nonce: string; tx_hash: string}[];
    expect(rows[0]).toMatchObject({status: 'broadcast', tx_hash: TX_HASH});
    expect(Number(rows[0]!.nonce)).toBe(4);
  });

  /**
   * The property the whole idempotency scheme exists for: a retried hire must
   * return the original payment, not make a second one.
   */
  it('returns the original hash for a repeated key without broadcasting again', async () => {
    const id = await anAgent();
    const signer = makeSigner();

    const first = await signer.sign(request(id, {idempotencyKey: 'same-key'}));
    const second = await signer.sign(request(id, {idempotencyKey: 'same-key'}));

    expect(second.txHash).toBe(first.txHash);
    expect(second.replayed).toBe(true);
    expect(state.broadcasts, 'a retry must not produce a second transaction').toBe(1);
  });

  it('treats a different key as a different payment', async () => {
    const id = await anAgent();
    const signer = makeSigner();

    await signer.sign(request(id, {idempotencyKey: 'key-one'}));
    state.nonce = 5;
    await signer.sign(request(id, {idempotencyKey: 'key-two'}));

    expect(state.broadcasts).toBe(2);
  });
});

describe('a failed broadcast', () => {
  /**
   * The row used to stay `pending` with no hash, which burned the key
   * forever: every retry was refused as "in flight", and topping the wallet
   * up did not help.
   */
  it('is recorded as failed rather than left pending', async () => {
    const id = await anAgent();
    state.broadcastError = 'insufficient funds for gas';

    await expectRefusal(
      makeSigner().sign(request(id, {idempotencyKey: 'fails-1'})),
      ErrorCode.INSUFFICIENT_FUNDS,
    );

    const rows = (await db.execute(
      sql`SELECT status, tx_hash FROM signer_txs WHERE idempotency_key = 'fails-1'`,
    )) as unknown as {status: string; tx_hash: string | null}[];
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.tx_hash).toBeNull();
  });

  it('names the wallet to fund when the failure is gas', async () => {
    const id = await anAgent();
    state.broadcastError = 'insufficient funds for gas * price + value';

    const err = await expectRefusal(
      makeSigner().sign(request(id)),
      ErrorCode.INSUFFICIENT_FUNDS,
    );
    expect(err.message).toMatch(ACCOUNT.address);
    expect(err.message).toMatch(/top it up/i);
  });

  /**
   * Retrying REUSES the stored nonce. If the original did reach the mempool
   * after all, two transactions with one nonce means only one can be mined —
   * so recovering cannot double-spend.
   */
  it('lets the same key retry once the problem is fixed, on the same nonce', async () => {
    const id = await anAgent();
    const signer = makeSigner();
    state.broadcastError = 'insufficient funds for gas';

    await expectRefusal(signer.sign(request(id, {idempotencyKey: 'recover-1'})), ErrorCode.INSUFFICIENT_FUNDS);

    // The wallet is topped up; the chain has moved on to a higher nonce.
    state.broadcastError = undefined as unknown as string;
    state.nonce = 99;

    const result = await signer.sign(request(id, {idempotencyKey: 'recover-1'}));
    expect(result.txHash).toBe(TX_HASH);
    expect(result.nonce, 'the retry must reuse the original nonce').toBe(4);
    expect(state.broadcasts).toBe(1);
  });

  it('reports an unreachable RPC as safe to retry, having broadcast nothing', async () => {
    const id = await anAgent();
    state.broadcastError = 'fetch failed';

    const err = await expectRefusal(makeSigner().sign(request(id)), ErrorCode.CHAIN_NOT_ENABLED);
    expect(err.message).toMatch(/NOT broadcast/);
    expect(state.broadcasts).toBe(0);
  });
});
