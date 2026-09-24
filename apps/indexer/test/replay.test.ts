import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {sql} from 'drizzle-orm';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb, closeDb, type Db} from '@agentx/db';
import {Indexer} from '../src/indexer.js';

/**
 * Replay safety — chaos checklist item 2, "kill the indexer, no duplicate rows".
 *
 * A replay is ORDINARY here, not exotic. The cursor is written after a batch
 * is processed, so any restart mid-batch re-reads it, and every reorg
 * deliberately rewinds twice the confirmation depth. So the question is not
 * whether logs get processed twice — they do — but whether processing one
 * twice changes anything.
 *
 * The events and payments tables were always protected by unique keys. The
 * reputation bump was not: it is `completed + 1`, and it ran whether or not
 * the event was new. Every replay credited the worker again, with no payment
 * behind it — inflating the one number this project claims can only be
 * written by a settled payment.
 *
 * These call `handleLog` through a narrow reach into the instance rather than
 * through `tick()`, because `tick()` needs an RPC and the behaviour under test
 * is entirely local.
 */

const DB_URL = process.env['DATABASE_URL'] ?? 'postgres://agentx:agentx@127.0.0.1:5442/agentx';

let db: Db;
let indexer: Indexer;

const config = loadConfig({
  contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
  env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
});
const chain = config.chain(31337);

beforeAll(() => {
  db = createDb(DB_URL, {max: 3});
  indexer = new Indexer({db, chain, abis: loadAbis() as never});
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE agents, jobs, job_events, agent_stats, agent_capabilities, api_keys, payments, runs, run_events RESTART IDENTITY CASCADE`,
  );
});

/** A settled job, already linked to its on-chain id. */
async function seedJob(): Promise<{jobId: number; workerId: number}> {
  const [client] = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
        VALUES (31337, '0xaa', '0xaa', 'Client', '20000', 1) RETURNING id`,
  )) as unknown as {id: number}[];
  const [worker] = (await db.execute(
    sql`INSERT INTO agents (chain_id, owner_address, wallet_address, name, price_per_task, chain_agent_id)
        VALUES (31337, '0xbb', '0xbb', 'Worker', '20000', 2) RETURNING id`,
  )) as unknown as {id: number}[];

  const [job] = (await db.execute(
    sql`INSERT INTO jobs (chain_id, client_agent_id, worker_agent_id, path, amount, spec, spec_hash, chain_job_id)
        VALUES (31337, ${client!.id}, ${worker!.id}, 'escrow', '20000', '{}'::jsonb, '0xspec', 7)
        RETURNING id`,
  )) as unknown as {id: number}[];

  await db.execute(sql`INSERT INTO agent_stats (agent_id) VALUES (${worker!.id})`);
  return {jobId: job!.id, workerId: worker!.id};
}

/** The same settled log the chain would hand us, as many times as we like. */
function settledLog(overrides: Record<string, unknown> = {}) {
  return {
    address: chain.contracts['TaskEscrow'] as `0x${string}`,
    blockNumber: 1234n,
    logIndex: 3,
    transactionHash: `0x${'ab'.repeat(32)}`,
    ...overrides,
  };
}

/** Bypasses decoding: the decoder needs real ABI-encoded data, the projection does not. */
async function feed(log: ReturnType<typeof settledLog>, kind: string, payload: Record<string, unknown>) {
  const inner = indexer as unknown as {
    decode: (entry: unknown) => Promise<unknown>;
    handleLog: (entry: unknown) => Promise<void>;
  };
  const original = inner.decode;
  inner.decode = async () => ({kind, chainJobId: '7', payload});
  try {
    await inner.handleLog.call(indexer, log);
  } finally {
    inner.decode = original;
  }
}

async function statsOf(workerId: number) {
  const rows = (await db.execute(
    sql`SELECT completed, failed, score, volume FROM agent_stats WHERE agent_id = ${workerId}`,
  )) as unknown as {completed: number; failed: number; score: number; volume: string}[];
  return rows[0]!;
}

async function countRows(table: 'job_events' | 'payments') {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
  )) as unknown as {n: number}[];
  return rows[0]!.n;
}

describe('replaying a settled event', () => {
  it('credits the worker exactly once', async () => {
    const {workerId} = await seedJob();
    const log = settledLog();
    const payload = {fee: '200', txHash: `0x${'cd'.repeat(32)}`};

    await feed(log, 'settled', payload);
    const first = await statsOf(workerId);
    expect(Number(first.completed)).toBe(1);

    // The same log again — a restart mid-batch, or a reorg rewind.
    await feed(log, 'settled', payload);
    await feed(log, 'settled', payload);

    const after = await statsOf(workerId);
    expect(Number(after.completed), 'a replay must not credit the worker again').toBe(1);
    expect(Number(after.score)).toBe(Number(first.score));
  });

  it('writes one event row and one payment row however many times it is replayed', async () => {
    await seedJob();
    const log = settledLog();
    const payload = {fee: '200', txHash: `0x${'cd'.repeat(32)}`};

    for (let i = 0; i < 4; i++) await feed(log, 'settled', payload);

    expect(await countRows('job_events')).toBe(1);
    expect(await countRows('payments')).toBe(1);
  });

  it('does not inflate settled volume on replay', async () => {
    const {workerId} = await seedJob();
    const log = settledLog();

    await feed(log, 'settled', {fee: '200', txHash: '0x01'});
    await feed(log, 'settled', {fee: '200', txHash: '0x01'});

    expect(BigInt((await statsOf(workerId)).volume)).toBe(20_000n);
  });

  /**
   * Two genuinely different events must both count — the guard is the unique
   * (chain, tx, logIndex) key, not "have we seen this job before".
   */
  it('still counts a second, genuinely different settlement', async () => {
    const {workerId} = await seedJob();

    await feed(settledLog(), 'settled', {fee: '200', txHash: '0x01'});
    await feed(
      settledLog({transactionHash: `0x${'ef'.repeat(32)}`, logIndex: 9, blockNumber: 1300n}),
      'settled',
      {fee: '200', txHash: '0x02'},
    );

    expect(Number((await statsOf(workerId)).completed)).toBe(2);
  });

  it('records the block the payment actually landed in, not zero', async () => {
    await seedJob();
    await feed(settledLog({blockNumber: 987n}), 'settled', {fee: '200', txHash: '0x01'});

    const rows = (await db.execute(
      sql`SELECT block_number FROM payments`,
    )) as unknown as {block_number: string}[];
    expect(Number(rows[0]!.block_number)).toBe(987);
  });
});

describe('replaying a refund', () => {
  it('counts a failure exactly once', async () => {
    const {workerId} = await seedJob();
    const log = settledLog({logIndex: 5});

    await feed(log, 'refunded', {reason: 'undelivered'});
    await feed(log, 'refunded', {reason: 'undelivered'});

    const stats = await statsOf(workerId);
    expect(Number(stats.failed)).toBe(1);
    expect(Number(stats.completed)).toBe(0);
  });

  /** A job nobody ever accepted is not the worker's fault. */
  it('does not blame the worker for a job that was never accepted', async () => {
    const {workerId} = await seedJob();
    await feed(settledLog({logIndex: 6}), 'refunded', {});

    expect(Number((await statsOf(workerId)).failed)).toBe(0);
  });
});
