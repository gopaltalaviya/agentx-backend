import type {FastifyInstance, FastifyRequest} from 'fastify';
import {and, asc, desc, eq, or} from 'drizzle-orm';
import {z} from 'zod';
import {agents, agentStats, jobEvents, jobs, type Db} from '@agentx/db';
import {
  AgentxError,
  BaseUnits,
  ErrorCode,
  HireRequest,
  JobResult,
  type JobSpec,
  JobState,
  canonicalize,
  validateShape,
} from '@agentx/shared';
import type {ChainConfig} from '@agentx/config';
import {authenticate, resolveChainId, type Caller} from '../auth.js';
import {streamEvents, type EventBus} from '../events.js';

/** Query for `GET /v1/jobs`. Coerced, because query strings are strings. */
const JobListQuery = z.object({
  role: z.enum(['worker', 'client']).optional(),
  state: JobState.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

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

    const clientRow = await db.query.agents.findFirst({where: eq(agents.id, caller.agentId)});

    // The contract addresses agents by their ERC-8004 id; the database uses
    // its own serial. Sending one where the other is expected targets a
    // different agent entirely — the transaction still succeeds, and pays
    // the wrong wallet. Refuse until both sides are known.
    if (!clientRow?.chainAgentId || !worker.chainAgentId) {
      throw new AgentxError(
        ErrorCode.AGENT_NOT_HIREABLE,
        'an agent is not yet registered on-chain (no ERC-8004 id) — retry once the indexer has seen it',
        2,
      );
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

    // Insert first so the job has an id, then commit to a hash that includes
    // it.
    //
    // The hash of a spec alone is NOT unique: two jobs asking the same
    // question produce the same hash, and the indexer — which links a job to
    // its on-chain event by this hash — would match an unrelated earlier
    // payment. Scoping the commitment to the job makes it identify THIS job,
    // which is what it was always meant to do. A client can still verify it:
    // keccak256(canonicalJson + ':' + jobId), both of which are in the receipt.
    const [inserted] = await db
      .insert(jobs)
      .values({
        chainId,
        clientAgentId: caller.agentId,
        workerAgentId,
        path,
        amount: price.toString(),
        spec: body.spec,
        specHash: '',
        traceId: request.id,
      })
      .returning();

    const specHash = await sha3(`${canonicalize(body.spec)}:${inserted!.id}`);
    const [job] = await db
      .update(jobs)
      .set({specHash})
      .where(eq(jobs.id, inserted!.id))
      .returning();

    const result = await submit({
      agentId: caller.agentId,
      chainId,
      kind: path === 'direct' ? 'directPay' : 'createJob',
      job: {id: job!.id, chainJobId: null},
      spend: price,
      idempotencyKey,
      payload: {
        // ERC-8004 ids, never the database's.
        clientChainAgentId: clientRow.chainAgentId,
        workerChainAgentId: worker.chainAgentId,
        amount: price.toString(),
        specHash,
      },
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

  /**
   * The caller's jobs.
   *
   * A worker has no other way to learn it was hired: the hire happens on the
   * client's side, and `/v1/jobs/:id/events` needs an id the worker does not
   * have yet. Without this a worker can only be told out of band, which is
   * not a marketplace.
   *
   * Polling rather than a push: a worker that drops its connection must still
   * pick the job up, and a missed offer expires on-chain into a refund the
   * client did not want.
   */
  app.get('/v1/jobs', async (request) => {
    const caller = await authenticate(db, request);
    const query = JobListQuery.parse(request.query ?? {});

    const side =
      query.role === 'worker'
        ? eq(jobs.workerAgentId, caller.agentId)
        : query.role === 'client'
          ? eq(jobs.clientAgentId, caller.agentId)
          : // Default to both: an orchestrator is a client AND is itself
            // hireable, and having to ask twice invites asking once.
            or(eq(jobs.workerAgentId, caller.agentId), eq(jobs.clientAgentId, caller.agentId));

    const rows = await db
      .select()
      .from(jobs)
      .where(
        query.state ? and(side, eq(jobs.state, query.state), eq(jobs.chainId, caller.chainId))
                    : and(side, eq(jobs.chainId, caller.chainId)),
      )
      // Oldest first: a worker should take the job closest to its accept
      // deadline, not the one that just arrived.
      .orderBy(asc(jobs.id))
      .limit(query.limit);

    return {
      count: rows.length,
      jobs: rows.map((job) => {
        const chain = chains[job.chainId]!;
        return {
          jobId: String(job.id),
          chainJobId: job.chainJobId,
          chainId: job.chainId,
          state: job.state,
          path: job.path,
          amount: job.amount,
          amountDisplay: chain.formatToken(BigInt(job.amount)),
          spec: job.spec,
          specHash: job.specHash,
          /** Which side the caller is on, so an agent need not infer it. */
          role: job.workerAgentId === caller.agentId ? ('worker' as const) : ('client' as const),
          clientAgentId: String(job.clientAgentId),
          workerAgentId: String(job.workerAgentId),
          createdAt: job.createdAt,
        };
      }),
    };
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
   * Checked twice before anything is stored or signed: the envelope, then the
   * output against the spec's own `outputSchema`.
   *
   * The second check is the one that matters, and it is checked HERE rather
   * than left to the client. Without it a worker can deliver an object with
   * none of the fields the client asked for, the API stores it, an on-chain
   * `submitResult` is sent for it, and the client discovers the problem only
   * by paying gas to dispute — while the worker learns it failed via a
   * permanent reputation hit instead of a 422 it could have acted on. The
   * transaction is not sent, because this runs before the transition submits
   * anything (docs/04 §7.3).
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

      const spec = job.spec as JobSpec;
      const shape = validateShape(parsed.data.output, spec.outputSchema);
      if (!shape.ok) {
        throw new AgentxError(
          ErrorCode.SCHEMA_MISMATCH,
          `${shape.reason} — the job asked for ${JSON.stringify(spec.outputSchema?.['required'] ?? [])}`,
        );
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

    streamEvents(
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

    // Every transition addresses the job by its ON-CHAIN id, which is assigned
    // when the contract runs and observed by the indexer a moment later.
    // Acting before then would encode id 0 and revert — so say plainly that
    // it is not ready yet, rather than emitting a doomed transaction.
    if (!job.chainJobId) {
      throw new AgentxError(
        ErrorCode.INVALID_STATE,
        'the job is not confirmed on-chain yet — retry in a moment',
        2,
      );
    }
    check(job, caller, request.body);

    const idempotencyKey =
      (request.headers['idempotency-key'] as string | undefined) ?? `${kind}:${job.id}:${job.state}`;

    // Computed BEFORE the transaction, because the chain commits to it.
    //
    // `result` means the worker's OUTPUT everywhere it is read — the worker
    // checks its own output against the job's outputSchema, and so do the API
    // and the orchestrator. Storing the delivery envelope under the same name
    // made those checks disagree about what they were looking at: a perfectly
    // good delivery would be read as `{output, producedAt}`, fail the
    // required-field check, and be disputed.
    //
    // The hash covers the output alone for the same reason, and because
    // including `producedAt` would give the same content a different
    // commitment on every delivery.
    const delivered =
      kind === 'submitResult'
        ? ((request.body as {output: Record<string, unknown>}).output ?? {})
        : undefined;
    const resultHash = delivered ? await sha3(canonicalize(delivered)) : undefined;

    const result = await submit({
      agentId: caller.agentId,
      chainId: job.chainId,
      kind,
      job: {id: job.id, chainJobId: job.chainJobId},
      // Only the hire moves money; the rest are state changes.
      spend: 0n,
      idempotencyKey,
      payload: {
        ...((request.body ?? {}) as Record<string, unknown>),
        // Without this the encoder falls back to the SPEC hash, so the chain
        // would commit to what was ASKED FOR rather than to what was
        // delivered — and T4's "the result hash is committed on-chain before
        // release" would not be true.
        ...(resultHash ? {resultHash} : {}),
      },
    });

    // Advance the state optimistically, once the transaction is accepted for
    // broadcast.
    //
    // The indexer is authoritative and will rewrite this from the chain's own
    // events. But it trails the head by `confirmations`, and a worker that
    // accepts a job and immediately submits its result cannot be made to wait
    // several blocks for our database to catch up — it would get a 409 for
    // doing exactly the right thing.
    //
    // So: the API writes what it believes, the indexer corrects it, and if
    // they ever disagree the chain wins.
    const patch: Record<string, unknown> = {state: to};
    if (delivered && resultHash) {
      patch['result'] = delivered;
      patch['resultHash'] = resultHash;
    }
    if (to === 'settled') patch['settledAt'] = new Date();

    await db.update(jobs).set(patch).where(eq(jobs.id, job.id));

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
