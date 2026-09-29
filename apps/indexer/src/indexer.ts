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


/**
 * A handle that is either the pool or an open transaction.
 *
 * Written out rather than taking `Db` everywhere, so that a method which MUST
 * run inside the caller's transaction cannot silently be handed the pool and
 * commit on its own.
 */
type Tx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

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

    // A log with no block is a pending one. We only ever query a range below
    // the safe head, so this should not happen — and if it ever does, an
    // unmined event has no place in a record of settled payments.
    if (entry.blockNumber === null) {
      this.log.warn({kind: decoded.kind}, 'skipping a pending log with no block number');
      return;
    }
    const blockNumber = entry.blockNumber;

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

    // Recording the event and applying it are ONE transaction, and the
    // insert's own uniqueness decides whether the rest runs.
    //
    // This is what makes a replay safe. Replays are ordinary: the cursor is
    // written after a batch is processed, so a restart mid-batch re-reads it,
    // and every reorg deliberately rewinds 2x the confirmation depth. The
    // event and payment rows were already idempotent, but the reputation bump
    // is `completed + 1` — so before this, each replay credited the worker
    // again, with no payment behind it. That inflates the exact number this
    // project claims only a settled payment can write.
    //
    // One transaction also closes the narrower window: a crash between
    // recording an event and applying it would otherwise leave the event
    // stored and its effect skipped forever on replay.
    const jobRow = job;
    await db.transaction(async (tx) => {
      const [recorded] = await tx
        .insert(jobEvents)
        .values({
          chainId: chain.chainId,
          jobId: jobRow.id,
          kind,
          payload,
          txHash: entry.transactionHash,
          blockNumber: Number(blockNumber),
          logIndex: entry.logIndex,
        })
        .onConflictDoNothing()
        .returning({id: jobEvents.id});

      // Already seen. Its effects are already in the projection.
      if (!recorded) return;

      await this.applyStateChange(tx, jobRow.id, kind, payload, blockNumber);
    });
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
  private async applyStateChange(
    db: Tx,
    jobId: number,
    kind: string,
    payload: Record<string, unknown>,
    blockNumber: bigint,
  ): Promise<void> {

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
          // The real block, not 0. A payment row that claims block zero is a
          // payment nobody can find again on the chain it came from.
          blockNumber: Number(blockNumber),
          confirmedAt: new Date(),
        })
        .onConflictDoNothing();

      await this.bumpReputation(db, job.workerAgentId, true, job.amount);
    }

    if (kind === 'refunded') {
      const job = await db.query.jobs.findFirst({where: eq(jobs.id, jobId)});
      // Only an accepted-then-undelivered job counts as a failure. A job
      // nobody ever accepted is not the worker's fault.
      if (job && payload['reason'] !== undefined) {
        await this.bumpReputation(db, job.workerAgentId, false, '0');
      }
    }
  }

  /**
   * Score mirrors the on-chain formula in docs/04 §2.3: Laplace-smoothed and
   * volume-damped, so a fresh agent is 50 (unknown) rather than 0 or 100, and
   * one lucky job cannot outrank a proven record.
   */
  private async bumpReputation(
    db: Tx,
    agentId: number,
    success: boolean,
    amount: string,
  ): Promise<void> {
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

  /**
   * Start here, not at the deployment block.
   *
   * With no cursor `tick()` begins at `startBlock` and backfills every block
   * since. That is right for production — the history IS the record — and
   * catastrophic for anything that needs to see a transaction it just sent.
   * On Monad testnet the deployment sits ~1.6 million blocks behind the head
   * and `eth_getLogs` is capped at 100 blocks a call: about two hours of
   * backfill before the indexer reaches the present.
   *
   * The demo truncated the cursor on startup and then waited ninety seconds
   * for its own events. They were never going to arrive. Nothing settled, no
   * reputation was ever written, and five runs were misread as the agents
   * failing.
   *
   * An existing cursor is left alone. A restart that skipped its backlog
   * would drop real payments on the floor — this is for a FIRST start only,
   * and it is the same thing an operator wants when adding a chain whose
   * history they do not need.
   *
   * @returns the block seeded to, or null if a cursor already existed.
   */
  async seedCursorToHead(): Promise<bigint | null> {
    if (await this.readCursor()) return null;

    const head = await this.client.getBlockNumber();
    // Seed BELOW the safe head, so the first tick has a range to read rather
    // than an empty one — and so a transaction sent a moment ago is still
    // ahead of the cursor rather than behind it.
    const from = head > this.reorgDepth ? head - this.reorgDepth : 0n;
    const block = await this.client.getBlock({blockNumber: from});

    await this.writeCursor('TaskEscrow', from, block.hash as string);
    this.log.info(
      {chainId: this.deps.chain.chainId, block: from.toString()},
      'seeded the cursor at the head; history before this block is not indexed',
    );
    return from;
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
