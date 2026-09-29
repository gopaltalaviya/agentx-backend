import Fastify, {type FastifyInstance} from 'fastify';
import cors from '@fastify/cors';
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
import type {BudgetReader, IdentityReader} from './chain-reads.js';

export interface AppDeps {
  db: Db;
  chains: Record<number, ChainConfig>;
  defaultChainId: number;
  submit: JobRouteDeps['submit'];
  bus?: EventBus;
  /** Omitted, /v1/budget answers from the cached policy and says so. */
  readBudget?: BudgetReader;
  /** Omitted, a registration that names an on-chain id is refused: it cannot be verified. */
  readIdentity?: IdentityReader;
  /** Omitted, the API serves everything except starting a run. */
  runExecutor?: RunExecutor;
  /** Browser origins allowed to call the API. Omitted, any origin may. */
  corsOrigins?: string[];
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

  // The interface lives on another origin (Vercel vs Railway; two ports
  // locally), and with no CORS headers every browser request was refused —
  // the first real render of the interface said "API unreachable" on every
  // page. Any origin is safe to allow because auth is a bearer key, never a
  // cookie: credentials are not allowed, so a hostile page can do nothing
  // here it could not do with curl. CORS_ORIGINS narrows it anyway.
  await app.register(cors, {
    origin: deps.corsOrigins && deps.corsOrigins.length > 0 ? deps.corsOrigins : '*',
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'last-event-id'],
    exposedHeaders: ['x-trace-id', 'retry-after'],
  });

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

  await registerAgentRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    ...(deps.readIdentity ? {readIdentity: deps.readIdentity} : {}),
  });
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
