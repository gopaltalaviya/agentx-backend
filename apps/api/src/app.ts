import Fastify, {type FastifyBaseLogger, type FastifyInstance} from 'fastify';
import helmet from '@fastify/helmet';
import {registerMetrics, serviceOptions, withTimeout, type BuildInfo, type Metrics} from '@agentx/service';
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
import {registerStatusRoutes, type StatusDeps} from './routes/status.js';
import {registerX402Routes} from './routes/x402.js';
import {RunService, type RunExecutor} from './runs.js';
import type {BudgetReader, IdentityReader, PaymentReader} from './chain-reads.js';

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
  /** Omitted, the x402 facilitator can settle but never confirms a payment. */
  readPayment?: PaymentReader;
  /** Omitted, the API serves everything except starting a run. */
  runExecutor?: RunExecutor;
  /** Browser origins allowed to call the API. Omitted, any origin may. */
  corsOrigins?: string[];
  /** Honour X-Forwarded-For. Set behind a proxy (Railway), never when exposed directly. */
  trustProxy?: boolean;
  /** Requests per client IP per minute. */
  rateLimitPerMinute?: number;
  /** Open SSE streams this instance holds, per stream kind (jobs, runs); past it, 503 + retry-after. */
  maxStreams?: number;
  /** Refuse non-public, non-https agent endpoint URLs (production). */
  requirePublicHttpsEndpoints?: boolean;
  logger?: boolean;
  /** A configured pino logger (redaction, service name). Wins over `logger`. */
  loggerInstance?: FastifyBaseLogger;
  /** Dependencies `/ready` checks — the database, and whatever else is wired. */
  readiness?: Record<string, () => Promise<unknown>>;
  /** Prometheus registry; `/metrics` is served when given. */
  metrics?: Metrics;
  metricsToken?: string;
  /** Serve `/metrics` only behind `metricsToken` (production: the API has a public domain). */
  requireMetricsToken?: boolean;
  /** What is running — reported on `/health` and `/v1/status`. */
  build?: BuildInfo;
  /** Dependencies `/v1/status` reports on. */
  status?: StatusDeps;
  /** Called for every route as it is registered — the docs test lists them. */
  onRoute?: (route: {method: string | string[]; url: string}) => void;
}

/** Liveness and readiness: what a load balancer reads. Exempt from the rate limit. */
const PROBE_PATHS = new Set(['/health', '/ready']);

/**
 * Built as a factory so tests can construct the whole API with an injected
 * `submit` and no signer, no chain and no network. A server you can only
 * exercise by starting it is a server nobody writes tests for.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Request ids: an incoming x-request-id is honoured, else a random UUID —
  // agents retry, and a trace id that survives into the response is how a
  // failed hire is connected to the log line explaining it. Body limit and
  // timeouts are explicit (serviceOptions).
  const app = Fastify({
    ...serviceOptions({trustProxy: deps.trustProxy ?? false}),
    ...(deps.loggerInstance ? {loggerInstance: deps.loggerInstance} : {logger: deps.logger ?? false}),
  });

  if (deps.onRoute) {
    const onRoute = deps.onRoute;
    app.addHook('onRoute', (route) => onRoute({method: route.method, url: route.url}));
  }

  const bus = deps.bus ?? new EventBus(deps.maxStreams);
  // A second bus, not a shared namespace: job 7 and run 7 are unrelated, and
  // one map keyed by number would deliver each other's events.
  const runBus = new EventBus(deps.maxStreams);

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
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'last-event-id', 'x-payment'],
    exposedHeaders: ['x-trace-id', 'retry-after'],
  });

  await app.register(rateLimit, {
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: '1 minute',
    // Per client IP, BEFORE authentication. It was keyed on the raw
    // Authorization header — so an attacker got a fresh bucket for every
    // garbage key, which made the per-request auth cost unbounded. With
    // TRUST_PROXY set, `req.ip` is the client, not Railway's proxy.
    keyGenerator: (req) => req.ip,
    // Never the probes. A client that spends its budget must not make the
    // instance look dead to the load balancer reading /health and /ready —
    // behind one shared egress IP that took a healthy instance out of rotation.
    allowList: (req) => PROBE_PATHS.has(req.url.split('?')[0] ?? ''),
  });

  registerErrorHandler(app);

  // Security headers. This is a JSON API, so the content policy is "nothing":
  // no script, no frame, no inline anything — a response rendered as a page
  // by mistake cannot become one.
  await app.register(helmet, {
    contentSecurityPolicy: {directives: {defaultSrc: ["'none'"], frameAncestors: ["'none'"]}},
    crossOriginResourcePolicy: {policy: 'cross-origin'}, // the interface is on another origin
  });

  if (deps.metrics) {
    registerMetrics(app, deps.metrics, {
      ...(deps.metricsToken ? {token: deps.metricsToken} : {}),
      requireToken: deps.requireMetricsToken ?? false,
    });
  }

  app.get('/ready', async (_request, reply) => {
    const checks = Object.entries(deps.readiness ?? {});
    const results = await Promise.all(
      checks.map(async ([name, check]) => {
        try {
          await withTimeout(check(), 2_000, `${name} did not answer within 2000 ms`);
          return [name, {ok: true}] as const;
        } catch (err) {
          // Named, never described: this endpoint is public, and a driver
          // error names the internal host it could not reach. The reason is
          // in the log.
          app.log.warn({err, check: name}, 'readiness check failed');
          return [name, {ok: false}] as const;
        }
      }),
    );
    const ok = results.every(([, r]) => r.ok);
    const detail: Record<string, {ok: boolean}> = {};
    for (const [name, result] of results) detail[name] = result;
    return reply.status(ok ? 200 : 503).send({ok, checks: detail});
  });

  // SSE streams never end by themselves; end them so close() does not wait.
  // preClose, not onClose: onClose runs only AFTER the server has closed,
  // which it cannot do while a stream is open.
  app.addHook('preClose', async () => {
    bus.closeAll();
    runBus.closeAll();
  });

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
    /** Which code this is: version, commit, build time. */
    build: deps.build ?? null,
  }));

  registerStatusRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    ...(deps.build ? {build: deps.build} : {}),
    ...(deps.status ? {status: deps.status} : {}),
  });

  await registerAgentRoutes(app, {
    db: deps.db,
    chains: deps.chains,
    defaultChainId: deps.defaultChainId,
    ...(deps.readIdentity ? {readIdentity: deps.readIdentity} : {}),
    requirePublicHttpsEndpoints: deps.requirePublicHttpsEndpoints ?? false,
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

  await registerX402Routes(app, {
    db: deps.db,
    chains: deps.chains,
    bus,
    submit: deps.submit,
    ...(deps.readPayment ? {readPayment: deps.readPayment} : {}),
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
