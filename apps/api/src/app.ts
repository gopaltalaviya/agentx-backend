import Fastify, {type FastifyInstance} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type {ChainConfig} from '@agentx/config';
import type {Db} from '@agentx/db';
import {registerErrorHandler} from './errors.js';
import {EventBus} from './events.js';
import {registerAgentRoutes} from './routes/agents.js';
import {registerJobRoutes, type JobRouteDeps} from './routes/jobs.js';
import {registerMetaRoutes} from './routes/meta.js';
import {registerRunRoutes} from './routes/runs.js';
import {RunService, type RunExecutor} from './runs.js';
import type {BudgetReader} from './chain-reads.js';

export interface AppDeps {
  db: Db;
  chains: Record<number, ChainConfig>;
  defaultChainId: number;
  submit: JobRouteDeps['submit'];
  bus?: EventBus;
  /** Omitted, /v1/budget answers from the cached policy and says so. */
  readBudget?: BudgetReader;
  /** Omitted, the API serves everything except starting a run. */
  runExecutor?: RunExecutor;
  logger?: boolean;
}

/**
 * Built as a factory so tests can construct the whole API with an injected
 * `submit` and no signer, no chain and no network. A server you can only
 * exercise by starting it is a server nobody writes tests for.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Agents retry; a trace id that survives into the response is how a
    // failed hire is connected to the log line explaining it.
    genReqId: () => `req_${Math.random().toString(36).slice(2, 10)}`,
  });

  const bus = deps.bus ?? new EventBus();
  // A second bus, not a shared namespace: job 7 and run 7 are unrelated, and
  // one map keyed by number would deliver each other's events.
  const runBus = new EventBus();

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    // Per API key, not per IP: every agent behind one Railway egress would
    // otherwise share a single bucket and throttle each other.
    keyGenerator: (req) => (req.headers.authorization ?? req.ip) as string,
  });

  registerErrorHandler(app);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-trace-id', request.id);
    return payload;
  });

  app.get('/health', async () => ({
    ok: true,
    chains: Object.values(deps.chains).map((c) => ({
      chainId: c.chainId,
      name: c.name,
      testnet: c.testnet,
      escrow: c.contracts['TaskEscrow'] ?? null,
    })),
    defaultChainId: deps.defaultChainId,
    subscribers: bus.subscriberCount + runBus.subscriberCount,
    /** Whether this deployment can start an orchestrator run at all. */
    orchestrator: Boolean(deps.runExecutor),
  }));

  await registerAgentRoutes(app, {db: deps.db, chains: deps.chains, defaultChainId: deps.defaultChainId});
  await registerJobRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    bus,
    submit: deps.submit,
  });
  await registerMetaRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    ...(deps.readBudget ? {readBudget: deps.readBudget} : {}),
  });

  await registerRunRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    runBus,
    ...(deps.runExecutor
      ? {
          runs: new RunService({
            db: deps.db,
            bus: runBus,
            execute: deps.runExecutor,
            log: (err, msg) => app.log.error({err}, msg),
          }),
        }
      : {}),
  });

  return app;
}

export {EventBus};
