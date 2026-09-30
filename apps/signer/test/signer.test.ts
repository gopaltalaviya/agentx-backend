import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import {fileURLToPath} from 'node:url';
import {
  decodeFunctionData,
  encodeAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
  type Hex,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sql} from 'drizzle-orm';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb, closeDb, createLockPool, closeLockPool, type Db, type LockPool} from '@agentx/db';
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
  /** A plain EOA: no code, so every contract read returns empty data. */
  eoa?: boolean;
  /** AgentAccount.owner(). Defaults to the held key. */
  owner: string;
  /** AgentAccount.sessionKeys(key).expiry, by lowercased key address. */
  sessionExpiry: Record<string, bigint>;
  /** The last broadcast, decoded — where it went and what it carried. */
  lastTx?: {to: string | undefined; data: Hex | undefined; raw: Hex};
  /** When set, eth_sendRawTransaction fails with this message. */
  broadcastError?: string;
  /** When set, eth_estimateGas reverts with this ABI-encoded error data. */
  estimateRevert?: Hex;
  broadcasts: number;
}

let state: ChainState;
let server: Server;
let rpcUrl: string;
let db: Db;
let locks: LockPool;

function reset(): ChainState {
  return {
    balanceWei: 10n ** 18n,
    nonce: 4,
    perTaskCap: 100_000n,
    dailyCap: 500_000n,
    dailyRemaining: 400_000n,
    dayStart: BigInt(Math.floor(Date.now() / 1000)),
    owner: ACCOUNT.address,
    sessionExpiry: {},
    broadcasts: 0,
  };
}

const uint = (v: bigint) => encodeAbiParameters([{type: 'uint256'}], [v]);

const SELECTORS = {
  dailyRemaining: toFunctionSelector('function dailyRemaining() view returns (uint128)'),
  dayStart: toFunctionSelector('function dayStart() view returns (uint64)'),
  owner: toFunctionSelector('function owner() view returns (address)'),
  sessionKeys: toFunctionSelector('function sessionKeys(address) view returns (uint64,uint128,uint128)'),
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
      if (state.estimateRevert) {
        throw Object.assign(new Error('execution reverted'), {code: 3, data: state.estimateRevert});
      }
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
      if (state.eoa) return '0x';
      const data = String((params[0] as {data?: string}).data ?? '');
      if (data.startsWith(SELECTORS.dailyRemaining)) return uint(state.dailyRemaining);
      if (data.startsWith(SELECTORS.dayStart)) return uint(state.dayStart);
      if (data.startsWith(SELECTORS.owner)) return encodeAbiParameters([{type: 'address'}], [state.owner as Hex]);
      if (data.startsWith(SELECTORS.sessionKeys)) {
        const key = `0x${data.slice(-40)}`.toLowerCase();
        return encodeAbiParameters(
          [{type: 'uint64'}, {type: 'uint128'}, {type: 'uint128'}],
          [state.sessionExpiry[key] ?? 0n, 0n, 0n],
        );
      }
      // policy() -> (uint128 perTaskCap, uint128 dailyCap, bool allowlistOnly)
      return encodeAbiParameters(
        [{type: 'uint128'}, {type: 'uint128'}, {type: 'bool'}],
        [state.perTaskCap, state.dailyCap, false],
      );
    }
    case 'eth_sendRawTransaction':
      if (state.broadcastError) throw new Error(state.broadcastError);
      state.broadcasts++;
      {
        const tx = parseTransaction(params[0] as Hex);
        state.lastTx = {to: tx.to ?? undefined, data: tx.data, raw: params[0] as Hex};
      }
      // The pending nonce advances, as a real node's does.
      state.nonce++;
      return TX_HASH;
    default:
      return null;
  }
}

beforeAll(async () => {
  state = reset();
  db = createDb(DB_URL, {max: 3});
  locks = createLockPool(DB_URL, {max: 10});

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
            error: {
              code: (err as {code?: number}).code ?? -32000,
              message: (err as Error).message,
              ...((err as {data?: string}).data ? {data: (err as {data?: string}).data} : {}),
            },
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
  await closeLockPool(locks);
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

function makeSigner(
  over: {gasFloorWei?: bigint; withKey?: boolean; keys?: unknown} = {},
): SignerService {
  const chain = {...baseConfig.chain(31337), rpcUrl} as ReturnType<typeof baseConfig.chain>;
  return new SignerService({
    db,
    locks,
    chain,
    abis: loadAbis() as never,
    keys: (over.keys ?? {
      accountFor: async () => (over.withKey === false ? null : ACCOUNT),
      all: () => (over.withKey === false ? [] : [ACCOUNT]),
    }) as never,
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

describe('signing as the right agent', () => {
  /**
   * The signer asked the keystore for "a key for agent 7" and used whatever
   * came back. With a single dev key that is ALWAYS the deployer's — so every
   * transaction went out from one address regardless of which agent the API
   * said it was acting for.
   *
   * On chain that is not a subtle mismatch. `TaskEscrow.acceptJob` checks
   * `identityRegistry.getAgentWallet(workerAgentId) == msg.sender`, so every
   * accept, every submitResult and every approve reverted with
   * `NotAgentWallet` — reported as "Execution reverted for an unknown
   * reason", which is what it looks like when the revert data is a custom
   * error nobody decoded.
   *
   * The identity IS the wallet here. Signing on behalf of an agent with a key
   * that is not its own is not a demo shortcut; it is the signer claiming to
   * be someone it is not, and the chain is right to refuse.
   */
  it('refuses rather than signing with a key that is not the agent\u2019s', async () => {
    const id = await anAgent();
    // A key the keystore holds, for somebody else entirely.
    const stranger = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);

    const signer = makeSigner({keys: {accountFor: async () => stranger}});

    const err = await expectRefusal(signer.sign(request(id)), ErrorCode.AGENT_NOT_HIREABLE);
    expect(err.message).toMatch(/wallet/i);
    expect(state.broadcasts).toBe(0);
  });

  it('signs when the key matches the wallet the agent is registered with', async () => {
    const id = await anAgent();
    const res = await makeSigner().sign(request(id));

    expect(res.txHash).toBe(TX_HASH);
    expect(state.broadcasts).toBe(1);
  });

  it('tells the keystore which wallet it needs, not only which agent', async () => {
    // A plain wallet signs for itself, so the keystore must produce ITS key.
    // (An AgentAccount wallet is signed for by a session key instead — below.)
    state.eoa = true;
    const id = await anAgent();
    await db.execute(
      sql`INSERT INTO spend_policies (agent_id, per_task_cap, daily_cap) VALUES (${id}, '100000', '1000000')`,
    );
    const asked: unknown[] = [];

    const signer = makeSigner({
      keys: {
        accountFor: async (...args: unknown[]) => {
          asked.push(args);
          return ACCOUNT;
        },
      },
    });

    await signer.sign(request(id));

    // A keystore holding one key per agent can only pick the right one if it
    // is told the address it has to match.
    expect(JSON.stringify(asked).toLowerCase()).toContain(ACCOUNT.address.toLowerCase());
  });
});

/**
 * An agent whose wallet is a plain EOA — which is every agent today.
 *
 * The caps were enforced nowhere for these. The signer read them from
 * `AgentAccount`, every read failed on an address with no code, and each
 * failure was treated as "no cap". `spend_policies.spent_today` was never
 * incremented, so `/v1/budget` never went down either. The claim the project
 * rests on — a hijacked agent cannot spend past its daily cap — held only for
 * a contract account nobody uses.
 */
describe('an EOA agent, which is every agent today', () => {
  async function withPolicy(perTaskCap: bigint, dailyCap: bigint, over: {spentToday?: bigint; hoursAgo?: number} = {}) {
    const agentId = await anAgent();
    await db.execute(
      sql`INSERT INTO spend_policies (agent_id, per_task_cap, daily_cap, spent_today, day_start)
          VALUES (${agentId}, ${perTaskCap.toString()}, ${dailyCap.toString()}, ${(over.spentToday ?? 0n).toString()},
                  now() - make_interval(hours => ${over.hoursAgo ?? 0}))`,
    );
    return agentId;
  }

  const spentToday = async (agentId: number) =>
    BigInt(
      ((await db.execute(sql`SELECT spent_today FROM spend_policies WHERE agent_id = ${agentId}`)) as unknown as {
        spent_today: string;
      }[])[0]!.spent_today,
    );

  beforeEach(() => {
    state.eoa = true;
  });

  it('refuses a spend over the per-task cap', async () => {
    const agentId = await withPolicy(30_000n, 1_000_000n);
    await expectRefusal(makeSigner().sign(request(agentId, {spend: 40_000n})), ErrorCode.BUDGET_EXCEEDED);
    expect(state.broadcasts).toBe(0);
  });

  it('counts what it signs, and refuses once the day would pass the cap', async () => {
    const agentId = await withPolicy(50_000n, 60_000n);
    const signer = makeSigner();

    await signer.sign(request(agentId, {spend: 40_000n}));
    expect(await spentToday(agentId)).toBe(40_000n);

    const refused = await expectRefusal(signer.sign(request(agentId, {spend: 40_000n})), ErrorCode.BUDGET_EXCEEDED);
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(state.broadcasts).toBe(1);
    expect(await spentToday(agentId)).toBe(40_000n);
  });

  it('does not charge the budget for a broadcast that failed', async () => {
    const agentId = await withPolicy(50_000n, 60_000n);
    state.broadcastError = 'insufficient funds for gas';
    await makeSigner().sign(request(agentId, {spend: 40_000n})).catch(() => undefined);
    expect(await spentToday(agentId)).toBe(0n);
  });

  it('does not charge twice for a retried request', async () => {
    const agentId = await withPolicy(50_000n, 60_000n);
    const signer = makeSigner();
    await signer.sign(request(agentId, {spend: 40_000n, idempotencyKey: 'same-key-001'}));
    await signer.sign(request(agentId, {spend: 40_000n, idempotencyKey: 'same-key-001'}));
    expect(await spentToday(agentId)).toBe(40_000n);
  });

  it('opens a new window once 24 hours have passed', async () => {
    const agentId = await withPolicy(50_000n, 60_000n, {spentToday: 60_000n, hoursAgo: 25});
    await makeSigner().sign(request(agentId, {spend: 40_000n}));
    expect(await spentToday(agentId)).toBe(40_000n);
  });

  /** No policy is not "no limit". */
  it('refuses to spend for an agent with no policy at all', async () => {
    const agentId = await anAgent();
    await expectRefusal(makeSigner().sign(request(agentId, {spend: 1n})), ErrorCode.BUDGET_EXCEEDED);
  });

  it('still signs calls that spend nothing', async () => {
    const agentId = await anAgent();
    const result = await makeSigner().sign(request(agentId, {spend: 0n}));
    expect(result.replayed).toBe(false);
  });
});

/**
 * An agent whose wallet is an AgentAccount — the contract the project's
 * headline claim rests on, and which no agent used until now.
 *
 * The signer used to sign every call as the wallet itself. For a contract
 * wallet that is impossible — nobody holds a contract's key — so the call
 * has to go TO the account, as execute(target, data), signed by a key the
 * account trusts; the account then makes the call and measures what it
 * spent against caps no hot key can change.
 */
describe('an agent whose wallet is an AgentAccount', () => {
  const CONTRACT = ('0x' + 'ac'.repeat(20)) as Hex;
  const HUMAN = '0x' + '0f'.repeat(20);

  async function accountAgent(): Promise<number> {
    const rows = (await db.execute(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES (31337, ${HUMAN}, ${CONTRACT}, 'Orchestrator', 0) RETURNING id`,
    )) as unknown as {id: number}[];
    return rows[0]!.id;
  }

  const asExecute = () => {
    const {functionName, args} = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'execute',
          stateMutability: 'nonpayable',
          inputs: [
            {name: 'target', type: 'address'},
            {name: 'data', type: 'bytes'},
          ],
          outputs: [{type: 'bytes'}],
        },
      ],
      data: state.lastTx!.data!,
    });
    return {functionName, target: String(args[0]).toLowerCase(), data: args[1]};
  };

  beforeEach(() => {
    state.owner = HUMAN;
    state.sessionExpiry = {[ACCOUNT.address.toLowerCase()]: BigInt(Math.floor(Date.now() / 1000) + 3600)};
  });

  it('sends execute(target, data) to the account, signed by a live session key', async () => {
    const agentId = await accountAgent();
    const req = request(agentId);

    await makeSigner().sign(req);

    expect(state.lastTx!.to!.toLowerCase()).toBe(CONTRACT);
    const call = asExecute();
    expect(call.functionName).toBe('execute');
    expect(call.target).toBe(req.target.toLowerCase());
    expect(call.data).toBe(req.data);
  });

  /** approve, dispute and cancel spend nothing and must still come from the account. */
  it('routes a call that spends nothing through the account too', async () => {
    const agentId = await accountAgent();
    await makeSigner().sign(request(agentId, {spend: 0n}));
    expect(state.lastTx!.to!.toLowerCase()).toBe(CONTRACT);
  });

  it('refuses when no key held here is trusted by the account', async () => {
    const agentId = await accountAgent();
    state.sessionExpiry = {[ACCOUNT.address.toLowerCase()]: BigInt(Math.floor(Date.now() / 1000) - 10)};

    const err = await expectRefusal(makeSigner().sign(request(agentId)), ErrorCode.AGENT_NOT_HIREABLE);
    expect(err.message).toMatch(/session key/);
    expect(state.broadcasts).toBe(0);
  });

  /** The chain holds these caps; a second, off-chain ledger would only drift from it. */
  it('leaves the cap to the account rather than to a policy row', async () => {
    const agentId = await accountAgent(); // no spend_policies row at all
    const result = await makeSigner().sign(request(agentId, {spend: 20_000n}));
    expect(result.replayed).toBe(false);
  });

  it('still refuses, before any gas, a spend the account would revert', async () => {
    const agentId = await accountAgent();
    await expectRefusal(makeSigner().sign(request(agentId, {spend: 150_000n})), ErrorCode.BUDGET_EXCEEDED);
    expect(state.broadcasts).toBe(0);
  });

  /**
   * A worker's account: caps of zero, because a worker never spends, and a
   * signer holding every demo agent's key. Accept and submit spend nothing,
   * so zero caps must not refuse them — and the key used must be the one
   * THIS account granted. The first key held is some other agent's; signing
   * with it reverts `NotAuthorized` and burns the gas limit.
   */
  it('signs a worker account’s zero-spend call with the key that account granted, not the first key held', async () => {
    const agentId = await accountAgent();
    const WORKER_KEY = privateKeyToAccount(`0x${'02'.repeat(32)}`);
    state.perTaskCap = 0n;
    state.dailyCap = 0n;
    state.dailyRemaining = 0n;
    state.sessionExpiry = {[WORKER_KEY.address.toLowerCase()]: BigInt(Math.floor(Date.now() / 1000) + 3600)};

    await makeSigner({keys: {accountFor: async () => null, all: () => [ACCOUNT, WORKER_KEY]}}).sign(
      request(agentId, {spend: 0n}),
    );

    expect(state.lastTx!.to!.toLowerCase()).toBe(CONTRACT);
    expect(asExecute().functionName).toBe('execute');
    const signedBy = await recoverTransactionAddress({serializedTransaction: state.lastTx!.raw as never});
    expect(signedBy.toLowerCase()).toBe(WORKER_KEY.address.toLowerCase());
  });
});

describe('after a broadcast that failed', () => {
  /**
   * A failed broadcast keeps its row — and its nonce — so a retry of the SAME
   * request reuses that nonce. But the chain never saw it, so the next
   * DIFFERENT request is given the same pending nonce, collides with the
   * failed row on (agent, nonce), and was refused as "a request with this key
   * is in flight". A live run lost a whole step to it: one gas shortfall
   * blocked every later hire by that agent.
   */
  it('lets the next request use the nonce the chain never saw', async () => {
    const agentId = await anAgent();
    const signer = makeSigner();

    state.broadcastError = 'insufficient funds for gas';
    await signer.sign(request(agentId)).catch(() => undefined);

    state.broadcastError = undefined;
    const next = await signer.sign(request(agentId));
    expect(next.replayed).toBe(false);
    expect(state.broadcasts).toBe(1);
  });

  it('still lets the failed request itself be retried', async () => {
    const agentId = await anAgent();
    const signer = makeSigner();
    const req = request(agentId, {idempotencyKey: 'retry-me-001'});

    state.broadcastError = 'insufficient funds for gas';
    await signer.sign(req).catch(() => undefined);
    await signer.sign(request(agentId)).catch(() => undefined); // a different request fails too
    state.broadcastError = undefined;

    expect((await signer.sign(req)).replayed).toBe(false);
  });
});

describe('what a failed broadcast is reported as', () => {
  /** The node's words were "Signer had insufficient balance"; we said the RPC was unreachable. */
  it('names an empty gas wallet as that, whatever the node calls it', async () => {
    const agentId = await anAgent();
    state.broadcastError = 'Signer had insufficient balance';
    await expectRefusal(makeSigner().sign(request(agentId)), ErrorCode.INSUFFICIENT_FUNDS);
  });

  /** "503" appeared inside the transaction's own hex, and matched the outage pattern. */
  it('does not read an outage into the hex of the transaction itself', async () => {
    const agentId = await anAgent();
    state.broadcastError = 'execution reverted: 0x4d11988c00005035030eb20edae3';
    const err = await expectRefusal(makeSigner().sign(request(agentId)), ErrorCode.INVALID_STATE);
    expect(err.message).not.toMatch(/unreachable/);
  });
});

/**
 * The per-agent lock must be released on the connection that took it.
 *
 * `pg_advisory_lock` is SESSION-scoped, and the pool hands each query to
 * whichever connection is free — so a lock taken on one connection and
 * "released" on another is not released at all: the unlock returns false,
 * and the lock stays held by an idle pooled connection for as long as it
 * lives. The next sign for that agent, on any other connection, then waits
 * forever. Found by the Session 26 audit; this reproduces it.
 */
describe('the per-agent lock', () => {
  const KEYS = [1, 2, 3, 4, 5].map((i) => privateKeyToAccount(`0x${String(i).padStart(2, '0').repeat(32)}` as Hex));

  async function agentFor(key: (typeof KEYS)[number]): Promise<number> {
    const rows = (await db.execute(
      sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task)
          VALUES (31337, ${key.address}, ${key.address}, 'Locker', 0) RETURNING id`,
    )) as unknown as {id: number}[];
    return rows[0]!.id;
  }

  const heldAdvisoryLocks = async () =>
    Number(
      ((await db.execute(
        sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`,
      )) as unknown as {n: number}[])[0]!.n,
    );

  it('holds no lock once concurrent signs across agents have finished', async () => {
    state.eoa = true;
    const signer = makeSigner({
      keys: {
        accountFor: async (_id: number, wallet: string) =>
          KEYS.find((k) => k.address.toLowerCase() === wallet.toLowerCase()) ?? null,
        all: () => KEYS,
      },
    });
    const agents = await Promise.all(KEYS.map(agentFor));

    // Concurrency is what makes the pool hand lock and unlock to different
    // connections; spend 0 needs no policy row.
    await Promise.all(
      Array.from({length: 4}, () => agents.map((id) => signer.sign(request(id, {spend: 0n})))).flat(),
    );
    expect(await heldAdvisoryLocks()).toBe(0);

    // And every agent can still be signed for, promptly.
    const again = Promise.all(agents.map((id) => signer.sign(request(id, {spend: 0n}))));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('a sign waited on a stuck lock')), 5_000));
    await Promise.race([again, timeout]);
  });

  it('releases the lock when the signing work throws', async () => {
    state.eoa = true;
    state.broadcastError = 'nonce too low';
    const agentId = await anAgent();
    await makeSigner()
      .sign(request(agentId, {spend: 0n}))
      .catch(() => undefined);
    expect(await heldAdvisoryLocks()).toBe(0);
  });
});

/**
 * A contract refusal, named. v1 reported any failed broadcast as INVALID_STATE
 * with viem's whole message — which can carry the transaction bytes, and
 * which hid WHICH rule refused. v2 adds rules a caller must be able to tell
 * apart: the same owner on both sides, a job below the minimum.
 */
describe('what a contract refusal is reported as', () => {
  const errorData = (signature: string, args: readonly unknown[] = []) =>
    (toFunctionSelector(signature) +
      (args.length
        ? encodeAbiParameters(
            args.map(() => ({type: 'uint128'})),
            args as never,
          ).slice(2)
        : '')) as Hex;

  it('names the escrow rule that refused, without the raw transaction', async () => {
    state.eoa = true;
    state.estimateRevert = errorData('SameOwner()');
    const agentId = await anAgent();
    const err = await expectRefusal(makeSigner().sign(request(agentId, {spend: 0n})), ErrorCode.INVALID_STATE);
    expect(err.detail).toMatch(/SameOwner/);
    expect(err.detail).not.toMatch(/0x02f8|0xf8/);
    expect(state.broadcasts).toBe(0);
  });

  it('decodes arguments too, so the caller learns the minimum', async () => {
    state.eoa = true;
    state.estimateRevert = errorData('AmountBelowMinimum(uint128,uint128)', [1n, 10_000n]);
    const agentId = await anAgent();
    const err = await expectRefusal(makeSigner().sign(request(agentId, {spend: 0n})), ErrorCode.INVALID_STATE);
    expect(err.detail).toMatch(/AmountBelowMinimum\(1, 10000\)/);
  });
});
