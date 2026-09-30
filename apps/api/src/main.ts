import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig} from '@agentx/config';
import {closeDb, createDb} from '@agentx/db';
import {createMetrics, env, installShutdown, loadEnv, serviceLogger} from '@agentx/service';
import {buildApp} from './app.js';
import {makeSignerSubmit} from './submit.js';
import {makeBudgetReader, makeIdentityReader, makePaymentReader} from './chain-reads.js';
import {makeRunExecutor} from './run-executor.js';

const Env = z
  .object({
    NODE_ENV: env.nodeEnv(),
    DATABASE_URL: env.postgresUrl(),
    PORT: env.port(8080),
    HOST: z.string().default('0.0.0.0'),
    SIGNER_URL: env.httpUrl().default('http://127.0.0.1:7070'),
    SIGNER_TOKEN: z.string().min(32).optional(),
    SIGNER_TIMEOUT_MS: env.positiveInt(30_000),
    AGENTX_SELF_URL: env.httpUrl().optional(),
    CORS_ORIGINS: env.csv(),
    TRUST_PROXY: env.flag(),
    RATE_LIMIT_PER_MINUTE: env.positiveInt(600),
    METRICS_TOKEN: z.string().optional(),
    LOG_LEVEL: env.logLevel(),
    DB_POOL_MAX: env.positiveInt(5),
  })
  // In production the browser origins must be named: `*` is fine for a local
  // demo and wrong for a deployment with a real front end.
  .refine((e) => e.NODE_ENV !== 'production' || e.CORS_ORIGINS.length > 0, {
    message: 'CORS_ORIGINS is required when NODE_ENV=production',
    path: ['CORS_ORIGINS'],
  });

const cfg = loadEnv(Env);
const logger = serviceLogger('api', cfg.LOG_LEVEL);

const config = loadConfig();
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});
const metrics = createMetrics('api');

// Resolved before the server starts: a deployment with no model key still
// serves the marketplace, and `/health` says plainly whether it can run.
// The reason is LOGGED — it used to be `.catch(() => null)`, so a mistyped
// key was indistinguishable from a deliberate "no orchestrator".
const runExecutor = await makeRunExecutor({
  baseUrl: cfg.AGENTX_SELF_URL ?? `http://127.0.0.1:${cfg.PORT}`,
  chainId: config.defaultChainId,
}).catch((err: unknown) => {
  logger.warn({err}, 'orchestrator unavailable; the API will serve everything except starting a run');
  return null;
});

const app = await buildApp({
  db,
  chains: config.chains,
  defaultChainId: config.defaultChainId,
  readBudget: makeBudgetReader(config),
  readIdentity: makeIdentityReader(config),
  readPayment: makePaymentReader(config),
  corsOrigins: cfg.CORS_ORIGINS,
  trustProxy: cfg.TRUST_PROXY,
  rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE,
  ...(runExecutor ? {runExecutor} : {}),
  submit: makeSignerSubmit({
    signerUrl: cfg.SIGNER_URL,
    ...(cfg.SIGNER_TOKEN ? {signerToken: cfg.SIGNER_TOKEN} : {}),
    timeoutMs: cfg.SIGNER_TIMEOUT_MS,
    config,
  }),
  readiness: {
    database: () => db.execute(sql`SELECT 1`),
    signer: async () => {
      const res = await fetch(`${cfg.SIGNER_URL}/health`, {signal: AbortSignal.timeout(2_000)});
      if (!res.ok) throw new Error(`signer /health answered ${res.status}`);
    },
  },
  metrics,
  ...(cfg.METRICS_TOKEN ? {metricsToken: cfg.METRICS_TOKEN} : {}),
  loggerInstance: logger,
});

installShutdown({
  logger,
  closers: [
    // Stops accepting, ends SSE streams, waits for in-flight requests.
    ['http', () => app.close()],
    ['database', () => closeDb(db)],
  ],
});

await app.listen({port: cfg.PORT, host: cfg.HOST});
logger.info(
  {
    port: cfg.PORT,
    chains: Object.keys(config.chains),
    orchestrator: Boolean(runExecutor),
    cors: cfg.CORS_ORIGINS,
  },
  'api listening',
);
