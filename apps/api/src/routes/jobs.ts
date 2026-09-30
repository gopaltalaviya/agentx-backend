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
    /** The caller's request id, carried to the signer. */
    traceId?: string;
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
    const hireKey: string = idempotencyKey;

    const body = HireRequest.parse(request.body);
    return reply
      .status(201)
      .send(await hire({db, bus, submit}, {caller, chainId, chain, idempotencyKey: hireKey, traceId: request.id}, body));
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
          jobId: job.publicId,
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
          /**
           * Whether the work has been delivered.
           *
           * State is not enough to tell. A fast-path job is `settled` the
           * moment it is created — the client has already paid — but nobody
           * has done the work yet, so a worker polling for `created` never
           * saw it and the client waited for a result no one was producing.
           */
          hasResult: job.result !== null,
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
      jobId: job.publicId,
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
        throw new AgentxError(ErrorCode.FORBIDDEN, 'only the assigned worker may accept');
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
    transition(request, 'submitResult', ['accepted', 'settled'], 'submitted', (job, caller, body) => {
      if (job.workerAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.FORBIDDEN, 'only the assigned worker may submit a result');
      }
      // `settled` is open only to the fast path, where it means "paid up
      // front, still owed the work". On an escrow job it means the client
      // has already approved and released — accepting a result then would
      // let a worker replace the thing that was paid for after the fact.
      if (job.state === 'settled' && job.path !== 'direct') {
        throw new AgentxError(
          ErrorCode.INVALID_STATE,
          'this job is settled — a result cannot be changed after the payment was released',
        );
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
        throw new AgentxError(ErrorCode.FORBIDDEN, 'only the client may approve');
      }
    }),
  );

  app.post('/v1/jobs/:id/dispute', async (request) =>
    transition(request, 'dispute', 'submitted', 'disputed', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.FORBIDDEN, 'only the client may dispute');
      }
    }),
  );

  app.post('/v1/jobs/:id/cancel', async (request) =>
    transition(request, 'cancel', 'created', 'refunded', (job, caller) => {
      if (job.clientAgentId !== caller.agentId) {
        throw new AgentxError(ErrorCode.FORBIDDEN, 'only the client may cancel');
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
    // Public ids only. A serial id — or anything else — names no job: 404,
    // not a 500 from handing NaN to Postgres.
    const job = isPublicId(params.id)
      ? await db.query.jobs.findFirst({where: eq(jobs.publicId, params.id)})
      : undefined;
    if (!job) throw new AgentxError(ErrorCode.NOT_FOUND, `no job ${params.id}`);
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
    from: string | string[],
    to: string,
    check: (job: typeof jobs.$inferSelect, caller: Caller, body: unknown) => void,
  ) {
    const caller = await authenticate(db, request);
    const {job, chain} = await loadJob(request.params as {id: string});

    if (job.chainId !== caller.chainId) {
      throw new AgentxError(ErrorCode.CHAIN_MISMATCH, `job is on chain ${job.chainId}`);
    }
    const allowed = Array.isArray(from) ? from : [from];
    if (!allowed.includes(job.state)) {
      throw new AgentxError(
        ErrorCode.INVALID_STATE,
        `job is "${job.state}", this action needs ${allowed.map((s) => `"${s}"`).join(' or ')}`,
      );
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

    // A direct-pay job is already finished on chain.
    //
    // `directPay` transfers, records the feedback and returns in one
    // transaction; there is no later call to attach a result to, and the
    // contract would revert on one. So the delivery is recorded off-chain
    // against the payment that already happened — the client paid up front
    // and is entitled to the work, and the hash still lets them prove what
    // they were given.
    const offChainOnly = kind === 'submitResult' && job.path === 'direct';

    const result = offChainOnly
      ? {txHash: null as string | null}
      : await submit({
      agentId: caller.agentId,
      chainId: job.chainId,
      kind,
      job: {id: job.id, chainJobId: job.chainJobId},
      // Only the hire moves money; the rest are state changes.
      spend: 0n,
      idempotencyKey,
          traceId: request.id,
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
    // A settled job stays settled: recording its delivery must not walk the
    // state backwards to `submitted` and un-settle a completed payment.
    const patch: Record<string, unknown> = offChainOnly ? {} : {state: to};
    if (delivered && resultHash) {
      patch['result'] = delivered;
      patch['resultHash'] = resultHash;
    }
    if (to === 'settled') patch['settledAt'] = new Date();

    if (Object.keys(patch).length > 0) {
      await db.update(jobs).set(patch).where(eq(jobs.id, job.id));
    }

    const finalState = offChainOnly ? job.state : to;

    await recordEvent(db, bus, job.id, job.chainId, offChainOnly ? 'job.delivered' : `job.${to}`, {
      jobId: job.publicId,
      txHash: result.txHash,
    });

    return {
      jobId: job.publicId,
      chainId: job.chainId,
      state: finalState,
      txHash: result.txHash,
      explorerUrl: result.txHash ? chain.explorerTx(result.txHash) : null,
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
/** A hire the client already made under this key, if any. */
/**
 * Hire an agent: the part of `POST /v1/jobs` after the caller is known.
 *
 * Exported because an x402 payment IS a hire — a fast-path one, bound to a
 * URL — and a second copy of this logic would be a second place for the
 * rules about idempotency, ERC-8004 ids and the fast path to drift apart.
 */
export async function hire(
  deps: Pick<JobRouteDeps, 'db' | 'bus' | 'submit'>,
  ctx: {caller: Caller; chainId: number; chain: ChainConfig; idempotencyKey: string; traceId: string},
  body: z.infer<typeof HireRequest>,
): Promise<ReturnType<typeof receipt>> {
  const {db, bus, submit} = deps;
  const {caller, chainId, chain, idempotencyKey} = ctx;
  const hireKey = idempotencyKey;
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

  // The escrow refuses any job below its minimum (v2): said here, before a
  // transaction is paid for only to revert.
  const minJobAmount = BigInt(chain.params.minJobAmount ?? 0n);
  if (price < minJobAmount) {
    throw new AgentxError(
      ErrorCode.AGENT_NOT_HIREABLE,
      `agent ${workerAgentId} charges ${chain.formatToken(price)}, below the escrow minimum of ${chain.formatToken(minJobAmount)}`,
    );
  }
  if (price > maxPrice) {
    throw new AgentxError(
      ErrorCode.PRICE_ABOVE_MAX,
      `agent charges ${chain.formatToken(price)}, above your maxPrice of ${chain.formatToken(maxPrice)}`,
    );
  }

  // Fast path vs escrow, decided here and always reported back, so a caller
  // is never uncertain whether its money is protected.
  //
  // The fast path pays before any work is done and has no recourse, so it
  // is a bet on the worker as much as a saving on gas: cheap is not enough,
  // the worker must also have the record `fastPathMinScore` asks for. That
  // parameter was configured and documented and read by nothing, so every
  // cheap hire of an agent with no history paid up front. An explicit
  // `path: 'direct'` is still the client's own call to make.
  const fastPathMax = chain.params.fastPathMax as bigint;
  const fastPathMinScore = Number(chain.params.fastPathMinScore ?? 0);
  const workerStats = await db.query.agentStats.findFirst({where: eq(agentStats.agentId, worker.id)});
  const earnedFastPath = (workerStats?.score ?? 0) >= fastPathMinScore;
  const path =
    body.path === 'auto' ? (price <= fastPathMax && earnedFastPath ? 'direct' : 'escrow') : body.path;

  // Insert first so the job has an id, then commit to a hash that includes
  // it.
  //
  // The hash of a spec alone is NOT unique: two jobs asking the same
  // question produce the same hash, and the indexer — which links a job to
  // its on-chain event by this hash — would match an unrelated earlier
  // payment. Scoping the commitment to the job makes it identify THIS job,
  // which is what it was always meant to do. A client can still verify it:
  // keccak256(canonicalJson + ':' + jobId), both of which are in the receipt.
  //
  // A retried hire — same client, same Idempotency-Key — is the SAME job.
  // It used to insert a new row every time: the signer rightly returned the
  // original transaction, so nothing was paid twice, but the retry answered
  // with a job id no transaction backed, and the worker was offered work
  // that had been paid for once.
  const prior = await findHire(db, caller.agentId, idempotencyKey);
  if (prior) {
    if (prior.workerAgentId !== workerAgentId || canonicalize(prior.spec) !== canonicalize(body.spec)) {
      throw new AgentxError(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        `Idempotency-Key ${idempotencyKey} was already used for job ${prior.id}, a different hire`,
      );
    }
    const txHash = await createdTxHash(db, prior.id);
    // Finished before: answer exactly as then. If it never got as far as a
    // transaction — the signer refused, or the wallet was out of gas — fall
    // through and submit again for the SAME row; the signer retries a
    // failed broadcast under the same key.
    if (txHash) return receipt(prior, chain, txHash);
  }

  const job = prior ?? (await insertHire());

  async function insertHire() {
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
        traceId: ctx.traceId,
        idempotencyKey: hireKey,
      })
      .returning();
    // The PUBLIC id — the one in the receipt — so the client can recompute it.
    const hashed = await sha3(`${canonicalize(body.spec)}:${inserted!.publicId}`);
    const [row] = await db.update(jobs).set({specHash: hashed}).where(eq(jobs.id, inserted!.id)).returning();
    return row!;
  }

  const specHash = job.specHash;
  const jobPath = job.path;
  const amount = BigInt(job.amount);

  const result = await submit({
    agentId: caller.agentId,
    chainId,
    kind: jobPath === 'direct' ? 'directPay' : 'createJob',
    job: {id: job.id, chainJobId: null},
    spend: amount,
    idempotencyKey,
    traceId: ctx.traceId,
    payload: {
      // ERC-8004 ids, never the database's.
      clientChainAgentId: clientRow.chainAgentId,
      workerChainAgentId: worker.chainAgentId,
      amount: amount.toString(),
      specHash,
    },
  });

  // What the row says and what the response says must be the same thing.
  //
  // A direct-pay job is paid, settled and terminal on chain the moment it
  // is created — `directPay` transfers, records the feedback and returns.
  // The response said `settled` while the row stayed `created`, so the API
  // reported one state and enforced another: every subsequent check read
  // `created` and refused, including the worker's own delivery.
  const settledNow = jobPath === 'direct';
  const creationPatch: Record<string, unknown> = {
    ...(result.chainJobId ? {chainJobId: result.chainJobId} : {}),
    ...(settledNow ? {state: 'settled', settledAt: new Date()} : {}),
  };
  // An escrow hire whose chain id the indexer has not linked yet leaves
  // nothing to write here, and drizzle rejects an empty `set` with "No
  // values to set" — a 500 on the ordinary path.
  if (Object.keys(creationPatch).length > 0) {
    await db.update(jobs).set(creationPatch).where(eq(jobs.id, job.id));
  }

  await recordEvent(db, bus, job.id, chainId, 'job.created', {
    jobId: job.publicId,
    txHash: result.txHash,
  });

  return receipt({...job, chainJobId: result.chainJobId ?? job.chainJobId}, chain, result.txHash);
}

async function findHire(db: Db, clientAgentId: number, idempotencyKey: string) {
  return db.query.jobs.findFirst({
    where: and(eq(jobs.clientAgentId, clientAgentId), eq(jobs.idempotencyKey, idempotencyKey)),
  });
}

/** The transaction that created this job, once there was one. */
async function createdTxHash(db: Db, jobId: number): Promise<string | null> {
  const event = await db.query.jobEvents.findFirst({
    where: and(eq(jobEvents.jobId, jobId), eq(jobEvents.kind, 'job.created')),
  });
  const txHash = (event?.payload as {txHash?: string} | undefined)?.txHash;
  return txHash ?? null;
}

/** What a hire answers with — the same for the first request and every retry of it. */
function receipt(
  job: {publicId: string; chainJobId: string | null; path: string; amount: string; specHash: string},
  chain: ChainConfig,
  txHash: string,
) {
  const amount = BigInt(job.amount);
  return {
    jobId: job.publicId,
    chainJobId: job.chainJobId ?? null,
    chainId: chain.chainId,
    network: chain.name,
    state: job.path === 'direct' ? 'settled' : 'created',
    path: job.path,
    amount: job.amount,
    amountDisplay: chain.formatToken(amount),
    specHash: job.specHash,
    txHash,
    explorerUrl: chain.explorerTx(txHash),
  };
}

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

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a public id (a uuid)? Anything else names nothing. */
export function isPublicId(id: string): boolean {
  return PUBLIC_ID.test(id);
}

async function sha3(input: string): Promise<string> {
  const {keccak256, toHex} = await import('viem');
  return keccak256(toHex(input));
}

export {desc, agentStats, BaseUnits, z};
