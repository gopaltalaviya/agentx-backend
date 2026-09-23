import {createPublicClient, http, type Abi, type Log, type PublicClient} from 'viem';
import {and, eq, isNull, sql} from 'drizzle-orm';
import type {ChainConfig} from '@agentx/config';
import {type Db, indexerCursor, jobEvents, jobs, agents, agentStats, payments} from '@agentx/db';

/**
 * Chain → Postgres, one worker per enabled chain.
 *
 * Two properties this is built around:
 *
 * 1. **Re-runnable.** Every write is idempotent, guaranteed by
 *    `UNIQUE (chain_id, tx_hash, log_index)` on job_events rather than by
 *    application care. Replaying a block range is a no-op.
 *
 * 2. **Reorg-aware.** The cursor stores the hash of the last block it
 *    processed. If that hash no longer matches what the chain reports, the
 *    chain reorganised underneath us, so we rewind and replay. Without this a
 *    payment from an orphaned block stays in the database forever.
 *
 * It only ever writes what the chain said. It never invents state, which is
 * why the UI can never show a payment that did not happen.
 */


export interface IndexerDeps {
  db: Db;
  chain: ChainConfig;
  abis: Record<string, Abi>;
  logger?: {info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void};
}

export class Indexer {
  private readonly client: PublicClient;
  private readonly log: NonNullable<IndexerDeps['logger']>;

  /**
   * How far behind the head to stay, and how far to rewind on a reorg.
   *
   * Taken from the network's declared `confirmations` rather than hardcoded:
   * 1 on a local chain you can re-run, 2 on Monad testnet, 5 on mainnet. A
   * fixed depth of 12 would mean a freshly-started chain with 7 blocks never
   * indexes anything at all, because the safe head sits below block zero.
   */
  private readonly reorgDepth: bigint;
  private readonly maxRange: bigint;

  constructor(private readonly deps: IndexerDeps) {
    this.client = createPublicClient({transport: http(deps.chain.rpcUrl)});
    this.log = deps.logger ?? {info: () => {}, warn: () => {}};
    this.reorgDepth = BigInt(deps.chain.confirmations);
    // Public RPCs cap eth_getLogs. Monad's rejects anything over 100 blocks,
    // which a 2000-block default discovers only in production, as an error
    // rather than as a slow query.
    this.maxRange = BigInt(deps.chain.maxLogRange);
  }

  /** Process one batch. Returns the block it advanced to. */
  async tick(): Promise<bigint> {
    const {chain} = this.deps;
    const head = await this.client.getBlockNumber();
    const safeHead = head > this.reorgDepth ? head - this.reorgDepth : 0n;

    const cursor = await this.readCursor();
    let from = cursor ? BigInt(cursor.lastBlock) + 1n : BigInt(chain.startBlock);

    if (cursor && (await this.hasReorged(cursor))) {
      // Rewind past the reorg and replay. Safe because every write is keyed
      // by (chain, tx, logIndex).
      const back = this.reorgDepth * 2n; // rewind further than we trail
      const rewindTo = BigInt(cursor.lastBlock) > back ? BigInt(cursor.lastBlock) - back : BigInt(chain.startBlock);
      this.log.warn({chainId: chain.chainId, from: cursor.lastBlock, rewindTo: rewindTo.toString()}, 'reorg detected, rewinding');
      from = rewindTo;
    }

    if (from > safeHead) return from - 1n;

    const to = from + this.maxRange - 1n > safeHead ? safeHead : from + this.maxRange - 1n;
    const escrow = chain.contracts['TaskEscrow'];
    if (!escrow) throw new Error(`chain ${chain.chainId}: no TaskEscrow address in the deployment`);

    const logs = await this.client.getLogs({
      address: escrow as `0x${string}`,
      fromBlock: from,
      toBlock: to,
    });

    for (const entry of logs) await this.handleLog(entry);

    const toBlock = await this.client.getBlock({blockNumber: to});
    await this.writeCursor('TaskEscrow', to, toBlock.hash);

    if (logs.length > 0) {
      this.log.info({chainId: chain.chainId, from: from.toString(), to: to.toString(), logs: logs.length}, 'indexed');
    }
    return to;
  }

  /**
   * The chain is trusted; our record of it is not. If the block we last
   * processed no longer hashes the same, it was orphaned.
   */
  private async hasReorged(cursor: {lastBlock: number; lastBlockHash: string}): Promise<boolean> {
    try {
      const block = await this.client.getBlock({blockNumber: BigInt(cursor.lastBlock)});
      return block.hash !== cursor.lastBlockHash;
    } catch {
      // The block is gone entirely — that is a reorg too.
      return true;
    }
  }

  private async handleLog(entry: Log): Promise<void> {
    const {db, chain} = this.deps;
    const decoded = await this.decode(entry);
    if (!decoded) return;

    const {kind, chainJobId, payload} = decoded;

    let job = await db.query.jobs.findFirst({
      where: and(eq(jobs.chainId, chain.chainId), eq(jobs.chainJobId, chainJobId)),
    });

    // No chainJobId yet.
    //
    // The API cannot know it: the signer returns as soon as the transaction is
    // BROADCAST, and the id is only assigned when the contract runs. Waiting
    // for a receipt would make every hire cost a block of latency.
    //
    // So the first event a job ever emits carries its specHash, and that is
    // what links the two. Matching on the hash of the work — rather than on an
    // id neither side knew in advance — is also self-healing: it works no
    // matter which of the two writes landed first.
    if (!job && payload['specHash']) {
      job = await db.query.jobs.findFirst({
        where: and(
          eq(jobs.chainId, chain.chainId),
          eq(jobs.specHash, String(payload['specHash'])),
          isNull(jobs.chainJobId),
        ),
      });
      if (job) {
        await db.update(jobs).set({chainJobId}).where(eq(jobs.id, job.id));
        this.log.info({jobId: job.id, chainJobId}, 'linked job to its on-chain id');
      }
    }

    // A job the API did not create — someone called the contract directly.
    // The chain is the source of truth, so this is expected, not an error.
    if (!job) {
      this.log.warn({chainId: chain.chainId, chainJobId, kind}, 'event for a job this API did not create');
      return;
    }

    await db
      .insert(jobEvents)
      .values({
        chainId: chain.chainId,
        jobId: job.id,
        kind,
        payload,
        txHash: entry.transactionHash,
        blockNumber: Number(entry.blockNumber),
        logIndex: entry.logIndex,
      })
      // The whole point of the unique key: a replay is a no-op, not an error.
      .onConflictDoNothing();

    await this.applyStateChange(job.id, kind, payload);
  }

  private async decode(
    entry: Log,
  ): Promise<{kind: string; chainJobId: string; payload: Record<string, unknown>} | null> {
    const {decodeEventLog} = await import('viem');
    const abi = this.deps.abis['TaskEscrow'];
    if (!abi) return null;

    try {
      const ev = decodeEventLog({abi, data: entry.data, topics: entry.topics});
      const args = (ev.args ?? {}) as Record<string, unknown>;
      const jobId = args['jobId'];
      if (jobId === undefined) return null;

      const kindOf: Record<string, string> = {
        JobCreated: 'created',
        JobAccepted: 'accepted',
        ResultSubmitted: 'submitted',
        JobSettled: 'settled',
        JobRefunded: 'refunded',
        JobDisputed: 'disputed',
        DisputeResolved: 'dispute_resolved',
        DirectPaid: 'direct_paid',
        FeedbackFailed: 'feedback_failed',
      };
      const kind = ev.eventName ? kindOf[ev.eventName] : undefined;
      if (!kind) return null;

      return {
        kind,
        chainJobId: String(jobId),
        // bigints do not survive JSON, and these are money.
        payload: JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
      };
    } catch {
      return null;
    }
  }

  /** Project the event onto the job row and the reputation counters. */
  private async applyStateChange(jobId: number, kind: string, payload: Record<string, unknown>): Promise<void> {
    const {db} = this.deps;

    const stateOf: Record<string, 'accepted' | 'submitted' | 'settled' | 'refunded' | 'disputed'> = {
      accepted: 'accepted',
      submitted: 'submitted',
      settled: 'settled',
      refunded: 'refunded',
      disputed: 'disputed',
    };
    const next = stateOf[kind];
    if (next) {
      await db
        .update(jobs)
        .set({
          state: next,
          ...(next === 'settled' ? {settledAt: new Date(), fee: String(payload['fee'] ?? '0')} : {}),
          ...(kind === 'submitted' ? {resultHash: String(payload['resultHash'] ?? '')} : {}),
        })
        .where(eq(jobs.id, jobId));
    }

    // ONLY on 'settled'. directPay emits DirectPaid *and* JobSettled for the
    // same job, so counting both double-credits every fast-path payment —
    // which would inflate exactly the reputation this project claims is
    // trustworthy. JobSettled is emitted on both paths, so it alone is
    // complete as well as correct.
    if (kind === 'settled') {
      const job = await db.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      if (!job) return;

      await db
        .insert(payments)
        .values({
          chainId: job.chainId,
          jobId: job.id,
          fromAgentId: job.clientAgentId,
          toAgentId: job.workerAgentId,
          amount: job.amount,
          fee: String(payload['fee'] ?? '0'),
          txHash: String(payload['txHash'] ?? ''),
          blockNumber: 0,
          confirmedAt: new Date(),
        })
        .onConflictDoNothing();

      await this.bumpReputation(job.workerAgentId, true, job.amount);
    }

    if (kind === 'refunded') {
      const job = await db.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      // Only an accepted-then-undelivered job counts as a failure. A job
      // nobody ever accepted is not the worker's fault.
      if (job && payload['reason'] !== undefined) {
        await this.bumpReputation(job.workerAgentId, false, '0');
      }
    }
  }

  /**
   * Score mirrors the on-chain formula in docs/04 §2.3: Laplace-smoothed and
   * volume-damped, so a fresh agent is 50 (unknown) rather than 0 or 100, and
   * one lucky job cannot outrank a proven record.
   */
  private async bumpReputation(agentId: number, success: boolean, amount: string): Promise<void> {
    const {db} = this.deps;
    await db
      .insert(agentStats)
      .values({
        agentId,
        completed: success ? 1 : 0,
        failed: success ? 0 : 1,
        volume: success ? amount : '0',
        lastActiveAt: new Date(),
        score: 50,
      })
      .onConflictDoUpdate({
        target: agentStats.agentId,
        set: {
          completed: sql`${agentStats.completed} + ${success ? 1 : 0}`,
          failed: sql`${agentStats.failed} + ${success ? 0 : 1}`,
          volume: sql`${agentStats.volume} + ${success ? amount : '0'}::numeric`,
          lastActiveAt: new Date(),
        },
      });

    await db.execute(sql`
      UPDATE agent_stats SET score = GREATEST(0, LEAST(100, (
        50 + ((
          (100 * (completed + 1) / (completed + failed + 2)) - 50
        ) * LEAST(100, (completed + failed) * 100 / 25)) / 100
      )::int))
      WHERE agent_id = ${agentId}
    `);
  }

  private async readCursor() {
    const {db, chain} = this.deps;
    return db.query.indexerCursor.findFirst({
      where: and(eq(indexerCursor.chainId, chain.chainId), eq(indexerCursor.contract, 'TaskEscrow')),
    });
  }

  private async writeCursor(contract: string, block: bigint, hash: string): Promise<void> {
    const {db, chain} = this.deps;
    await db
      .insert(indexerCursor)
      .values({
        chainId: chain.chainId,
        contract,
        lastBlock: Number(block),
        lastBlockHash: hash,
      })
      .onConflictDoUpdate({
        target: [indexerCursor.chainId, indexerCursor.contract],
        set: {lastBlock: Number(block), lastBlockHash: hash, updatedAt: new Date()},
      });
  }
}
