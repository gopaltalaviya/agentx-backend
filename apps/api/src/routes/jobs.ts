import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq} from 'drizzle-orm';
import {z} from 'zod';
import {agents, agentStats, jobEvents, jobs, type Db} from '@agentx/db';
import {AgentxError, BaseUnits, ErrorCode, HireRequest, JobResult, canonicalize} from '@agentx/shared';
import type {ChainConfig} from '@agentx/config';
import {authenticate, resolveChainId, type Caller} from '../auth.js';
import {streamJobEvents, type EventBus} from '../events.js';

export interface JobRouteDeps {
  db: Db;
  chains: Record<number, ChainConfig>;
  defaultChainId: number;
  bus: EventBus;
  /** Submits a policy-checked transaction. Injected so tests need no signer. */
  submit: (args: {
    agentId: number;
    chainId: number;
    kind: 'createJob' | 'directPay' | 'accept' | 'submitResult' | 'approve' | 'dispute' | 'cancel';
    job?: {id: number; chainJobId: string | null};
    spend: bigint;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  }) => Promise<{txHash: string; chainJobId?: string}>;
}

export async function registerJobRoutes(app: FastifyInstance, deps: JobRouteDeps): Promise<void> {
  const {db, chains, bus, submit} = deps;
  const enabled = Object.keys(chains).map(Number);

  /**
   * Hire an agent.
   *
   * Requires an Idempotency-Key. Agents retry — a dropped response, a timeout,
   * a restart — and a retried hire must never create a second job or a second
   * payment.
   */
  app.post('/v1/jobs', async (request, reply) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);
    const chain = chains[chainId]!;

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      throw new AgentxError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'Idempotency-Key header is required on any request that spends money',
      );
    }

    const body = HireRequest.parse(request.body);
    const workerAgentId = Number(body.workerAgentId);

    if (workerAgentId === caller.agentId) {
      throw new AgentxError(ErrorCode.INVALID_STATE, 'an agent cannot hire itself');
    }

    const worker = await db.query.agents.findFirst({
      where: and(eq(agents.id, workerAgentId), eq(agents.chainId, chainId)),
    });
    if (!worker) {
      throw new AgentxError(ErrorCode.AGENT_NOT_HIREABLE, `no agent ${workerAgentId} on chain ${chainId}`);
    }
    if (!worker.active) {
      throw new AgentxError(ErrorCode.AGENT_NOT_HIREABLE, `agent ${workerAgentId} is not accepting work`);
    }

    const price = BigInt(worker.pricePerTask);
    const maxPrice = BigInt(body.maxPrice);
    if (price > maxPrice) {
      throw new AgentxError(
        ErrorCode.PRICE_ABOVE_MAX,
        `agent charges ${chain.formatToken(price)}, above your maxPrice of ${chain.formatToken(maxPrice)}`,
      );
    }

    // Fast path vs escrow, decided here and always reported back, so a caller
    // is never uncertain whether its money is protected.
    const fastPathMax = chain.params.fastPathMax as bigint;
    const path =
      body.path === 'auto' ? (price <= fastPathMax ? 'direct' : 'escrow') : body.path;

    const specJson = canonicalize(body.spec);
    const specHash = await sha3(specJson);

    const [job] = await db
      .insert(jobs)
      .values({
        chainId,
        clientAgentId: caller.agentId,
        workerAgentId,
        path,
        amount: price.toString(),
        spec: body.spec,
        specHash,
        traceId: request.id,
      })
      .returning();

    const result = await submit({
      agentId: caller.agentId,
      chainId,
      kind: path === 'direct' ? 'directPay' : 'createJob',
      job: {id: job!.id, chainJobId: null},
      spend: price,
      idempotencyKey,
      payload: {workerAgentId, amount: price.toString(), specHash},
    });

    if (result.chainJobId) {
      await db.update(jobs).set({chainJobId: result.chainJobId}).where(eq(jobs.id, job!.id));
    }

    await recordEvent(db, bus, job!.id, chainId, 'job.created', {
      jobId: String(job!.id),
      txHash: result.txHash,
    });

    return reply.status(201).send({
      jobId: String(job!.id),
      chainJobId: result.chainJobId ?? null,
      chainId,
      network: chain.name,
      state: path === 'direct' ? 'settled' : 'created',
      path,
      amount: price.toString(),
      amountDisplay: chain.formatToken(price),
      specHash,
      txHash: result.txHash,
      explorerUrl: chain.explorerTx(result.txHash),
    });
  });

  app.get('/v1/jobs/:id', async (request) => {
    const {job, chain} = await loadJob(request.params as {id: string});
    const events = await db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
      .orderBy(asc(jobEvents.id));

    return {
      jobId: String(job.id),
      chainJobId: job.chainJobId,
      chainId: job.chainId,
      network: chain.name,
      state: job.state,
      path: job.path,
      amount: job.amount,
      amountDisplay: chain.formatToken(BigInt(job.amount)),
      fee: job.fee,
      spec: job.spec,
      specHash: job.specHash,
      result: job.result,
      resultHash: job.resultHash,
      createdAt: job.createdAt,
      settledAt: job.settledAt,
      events: events.map((e) => ({
        kind: e.kind,
        txHash: e.txHash,
        explorerUrl: e.txHash ? chain.explorerTx(e.txHash) : null,
        occurredAt: e.occurredAt,
      })),
    };
  });

  /** Worker accepts. Only the assigned worker, only from `created`. */
  app.post('/v1/jobs/:id/accept', async (request) =>
    transition(request, 'accept', 'created', 'accepted', (job, caller) => {
      if (job.workerAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.CHAIN_MISMATCH, 'only the assigned worker may accept');
      }
    }),
  );

  /**
   * Worker submits a result.
   *
   * Validated against the spec's outputSchema BEFORE it is stored, so a
   * malformed result is rejected at the boundary rather than reaching a model
   * that might act on it (docs/04 §7.3).
   */
  app.post('/v1/jobs/:id/result', async (request) =>
    transition(request, 'submitResult', 'accepted', 'submitted', (job, caller, body) => {
      if (job.workerAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.CHAIN_MISMATCH, 'only the assigned worker may submit a result');
      }
      const parsed = JobResult.safeParse(body);
      if (!parsed.success) {
        throw new AgentxError(ErrorCode.SCHEMA_MISMATCH, parsed.error.issues.map((i) => i.message).join('; '));
      }
    }),
  );

  app.post('/v1/jobs/:id/approve', async (request) =>
    transition(request, 'approve', 'submitted', 'settled', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.CHAIN_MISMATCH, 'only the client may approve');
      }
    }),
  );

  app.post('/v1/jobs/:id/dispute', async (request) =>
    transition(request, 'dispute', 'submitted', 'disputed', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.CHAIN_MISMATCH, 'only the client may dispute');
      }
    }),
  );

  app.post('/v1/jobs/:id/cancel', async (request) =>
    transition(request, 'cancel', 'created', 'refunded', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.CHAIN_MISMATCH, 'only the client may cancel');
      }
    }),
  );

  /** Live job feed. Replays history first so a late subscriber sees it all. */
  app.get('/v1/jobs/:id/events', async (request, reply) => {
    const {job} = await loadJob(request.params as {id: string});
    const past = await db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, job.id))
      .orderBy(asc(jobEvents.id));

    streamJobEvents(
      reply,
      bus,
      job.id,
      past.map((e) => ({event: e.kind, data: (e.payload ?? {}) as Record<string, unknown>})),
    );
    return reply;
  });

  // ── helpers ────────────────────────────────────────────────────────────

  async function loadJob(params: {id: string}) {
    const job = await db.query.jobs.findFirst({where: eq(jobs.id, Number(params.id))});
    if (!job) throw new AgentxError(ErrorCode.INVALID_STATE, `no job ${params.id}`);
    const chain = chains[job.chainId];
    if (!chain) throw new AgentxError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${job.chainId} is not enabled`);
    return {job, chain};
  }

  /**
   * One implementation for every state change: authenticate, check the
   * transition is legal, submit on-chain, record, publish.
   *
   * The contract is the authority — this check exists so a caller gets a clear
   * error instead of a bare revert, not because the API is trusted.
   */
  async function transition(
    request: FastifyRequest,
    kind: 'accept' | 'submitResult' | 'approve' | 'dispute' | 'cancel',
    from: string,
    to: string,
    check: (job: typeof jobs.$inferSelect, caller: Caller, body: unknown) => void,
  ) {
    const caller = await authenticate(db, request);
    const {job, chain} = await loadJob(request.params as {id: string});

    if (job.chainId !== caller.chainId) {
      throw new AgentxError(ErrorCode.CHAIN_MISMATCH, `job is on chain ${job.chainId}`);
    }
    if (job.state !== from) {
      throw new AgentxError(ErrorCode.INVALID_STATE, `job is "${job.state}", this action needs "${from}"`);
    }
    check(job, caller, request.body);

    const idempotencyKey =
      (request.headers['idempotency-key'] as string | undefined) ?? `${kind}:${job.id}:${job.state}`;

    const result = await submit({
      agentId: caller.agentId,
      chainId: job.chainId,
      kind,
      job: {id: job.id, chainJobId: job.chainJobId},
      // Only the hire moves money; the rest are state changes.
      spend: 0n,
      idempotencyKey,
      payload: (request.body ?? {}) as Record<string, unknown>,
    });

    if (kind === 'submitResult') {
      const body = request.body as {result?: unknown};
      await db
        .update(jobs)
        .set({result: (body.result ?? body) as object, resultHash: await sha3(canonicalize(body.result ?? body))})
        .where(eq(jobs.id, job.id));
    }

    await recordEvent(db, bus, job.id, job.chainId, `job.${to}`, {
      jobId: String(job.id),
      txHash: result.txHash,
    });

    return {
      jobId: String(job.id),
      chainId: job.chainId,
      state: to,
      txHash: result.txHash,
      explorerUrl: chain.explorerTx(result.txHash),
    };
  }
}

/**
 * Off-chain event row plus a live publish.
 *
 * `txHash` is deliberately NULL here: these are API-side events. The indexer
 * writes the on-chain ones with their real hash and log index, and the unique
 * constraint keeps the two from colliding.
 */
async function recordEvent(
  db: Db,
  bus: EventBus,
  jobId: number,
  chainId: number,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(jobEvents).values({chainId, jobId, kind, payload}).onConflictDoNothing();
  bus.publish(jobId, {event: kind, data: payload});
}

async function sha3(input: string): Promise<string> {
  const {keccak256, toHex} = await import('viem');
  return keccak256(toHex(input));
}

export {desc, agentStats, BaseUnits, z};
