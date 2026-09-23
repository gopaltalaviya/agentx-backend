import type {FastifyInstance} from 'fastify';
import {and, asc, desc, eq} from 'drizzle-orm';
import {z} from 'zod';
import {runEvents, runs, type Db} from '@agentx/db';
import {AgentxError, ErrorCode} from '@agentx/shared';
import type {ChainConfig} from '@agentx/config';
import {authenticate, resolveChainId} from '../auth.js';
import {streamEvents, type EventBus} from '../events.js';
import type {RunService} from '../runs.js';

/**
 * Orchestrator runs: one goal in, a trace and an answer out.
 *
 * This is what the live demo page is built on. A run is started, its id comes
 * back immediately, and everything after that is read from the stream — so
 * the page can show the first event rather than joining halfway through.
 *
 * Reading a run is public. The trace is the thing being demonstrated, and a
 * judge following a link should not need a key to watch it; starting one is
 * not, because it spends.
 */

const StartRun = z.object({
  goal: z.string().min(3).max(2_000),
});

export interface RunRouteDeps {
  db: Db;
  chains: Record<number, ChainConfig>;
  runBus: EventBus;
  /** Absent when no model is configured; starting a run then fails cleanly. */
  runs?: RunService;
}

export async function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): Promise<void> {
  const {db, chains, runBus} = deps;
  const enabled = Object.keys(chains).map(Number);

  app.post('/v1/runs', async (request, reply) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);

    if (!deps.runs) {
      throw new AgentxError(
        ErrorCode.CHAIN_NOT_ENABLED,
        'this deployment has no orchestrator configured — set a model provider key and restart',
      );
    }

    const {goal} = StartRun.parse(request.body);

    // The API key is carried into the run because the orchestrator acts AS
    // this agent: it hires under this agent's identity and spends under this
    // agent's on-chain caps. A run that ran under anything else would not be
    // bounded by the caps the owner actually set.
    const auth = (request.headers.authorization ?? '').slice('Bearer '.length).trim();
    const {runId} = await deps.runs.start({chainId, agentId: caller.agentId, apiKey: auth, goal});

    return reply.status(202).send({
      runId: String(runId),
      chainId,
      state: 'running',
      /** Subscribe here before the first event lands. */
      eventsUrl: `/v1/runs/${runId}/events`,
    });
  });

  app.get('/v1/runs', async (request) => {
    const caller = await authenticate(db, request);
    const limit = Math.min(Number((request.query as {limit?: string}).limit ?? 20), 100);

    const rows = await db
      .select()
      .from(runs)
      .where(and(eq(runs.agentId, caller.agentId), eq(runs.chainId, caller.chainId)))
      // Newest first here, unlike jobs: a list of runs is a history to browse,
      // not a queue to work through.
      .orderBy(desc(runs.id))
      .limit(limit);

    return {count: rows.length, runs: rows.map(summarise)};
  });

  app.get('/v1/runs/:id', async (request) => {
    const run = await load(request.params as {id: string});
    const events = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.id));

    return {
      ...summarise(run),
      answer: run.answer,
      steps: run.steps,
      error: run.error,
      events: events.map((e) => ({kind: e.kind, payload: e.payload, occurredAt: e.occurredAt})),
    };
  });

  app.get('/v1/runs/:id/events', async (request, reply) => {
    const run = await load(request.params as {id: string});
    const past = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, run.id))
      .orderBy(asc(runEvents.id));

    streamEvents(
      reply,
      runBus,
      run.id,
      past.map((e) => ({event: e.kind, data: (e.payload ?? {}) as Record<string, unknown>})),
    );
    return reply;
  });

  async function load(params: {id: string}) {
    const run = await db.query.runs.findFirst({where: eq(runs.id, Number(params.id))});
    if (!run) throw new AgentxError(ErrorCode.INVALID_STATE, `no run ${params.id}`);
    return run;
  }

  function summarise(run: typeof runs.$inferSelect) {
    const chain = chains[run.chainId];
    return {
      runId: String(run.id),
      chainId: run.chainId,
      network: chain?.name ?? String(run.chainId),
      testnet: chain?.testnet ?? true,
      goal: run.goal,
      state: run.state,
      spent: run.spent,
      spentDisplay: chain ? chain.formatToken(BigInt(run.spent)) : run.spent,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }
}
