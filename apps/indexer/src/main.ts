import Fastify from 'fastify';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig, loadAbis} from '@agentx/config';
import {closeDb, createDb} from '@agentx/db';
import {
  createMetrics,
  env,
  installShutdown,
  loadEnv,
  registerHealth,
  registerMetrics,
  serviceLogger,
  serviceOptions,
} from '@agentx/service';
import {Indexer} from './indexer.js';
import {runIndexerLoop} from './loop.js';

/**
 * One indexer worker per enabled chain, all in one process.
 *
 * Running testnet and mainnet together is a config value, not a second
 * deployment — `ENABLED_CHAIN_IDS=10143,143` and both are watched.
 */
const Env = z.object({
  DATABASE_URL: env.postgresUrl(),
  INDEXER_POLL_MS: env.positiveInt(2_000),
  INDEXER_MAX_BACKOFF_MS: env.positiveInt(60_000),
  /** Optional: serve /health, /ready and /metrics. A worker has no other face. */
  INDEXER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  METRICS_TOKEN: z.string().optional(),
  LOG_LEVEL: env.logLevel(),
  DB_POOL_MAX: env.positiveInt(3),
});

const cfg = loadEnv(Env);
const logger = serviceLogger('indexer', cfg.LOG_LEVEL);

const config = loadConfig();
const abis = loadAbis() as Record<string, never>;
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});

const metrics = createMetrics('indexer');
const ticks = metrics.counter('indexer_ticks_total', 'Indexer ticks, by chain and outcome', ['chain', 'outcome']);
const lastOk = metrics.gauge('indexer_last_success_seconds', 'Unix time of the last successful tick', ['chain']);
const lastSuccess = new Map<number, number>();

const health = cfg.INDEXER_HEALTH_PORT ? Fastify({...serviceOptions(), logger: false}) : null;

const shutdown = installShutdown({
  logger,
  closers: [
    // The loops watch the shutdown signal and return after their current tick.
    ['workers', () => workersDone],
    ['health', async () => health?.close()],
    ['database', () => closeDb(db)],
  ],
});

const workersDone = Promise.all(
  Object.values(config.chains).map((chain) => {
    const indexer = new Indexer({db, chain, abis, logger});
    logger.info({chainId: chain.chainId, name: chain.name, startBlock: chain.startBlock}, 'indexer started');

    return runIndexerLoop(
      async () => {
        await indexer.tick();
        const now = Date.now();
        lastSuccess.set(chain.chainId, now);
        lastOk.labels(String(chain.chainId)).set(Math.floor(now / 1000));
        ticks.labels(String(chain.chainId), 'ok').inc();
      },
      {
        pollMs: cfg.INDEXER_POLL_MS,
        maxBackoffMs: cfg.INDEXER_MAX_BACKOFF_MS,
        signal: shutdown.signal,
        onError: (err, failures, nextDelayMs) => {
          ticks.labels(String(chain.chainId), 'failed').inc();
          // Escalate with persistence. One failed tick is noise on any public
          // RPC; twenty in a row is an outage someone needs to see.
          const line = {chainId: chain.chainId, err: (err as Error).message, failures, retryingInMs: nextDelayMs};
          failures >= 5 ? logger.error(line, 'indexer is failing') : logger.warn(line, 'tick failed, retrying');
        },
        onRecovered: (afterFailures) => logger.info({chainId: chain.chainId, afterFailures}, 'indexer recovered'),
      },
    );
  }),
);

if (health) {
  // Ready = the database answers AND every chain indexed successfully within
  // the backoff ceiling. Behind that, the indexer is failing, not waiting.
  registerHealth(health, {
    checks: {
      database: () => db.execute(sql`SELECT 1`),
      ...Object.fromEntries(
        Object.values(config.chains).map((chain) => [
          `chain-${chain.chainId}`,
          async () => {
            const at = lastSuccess.get(chain.chainId);
            const limit = cfg.INDEXER_MAX_BACKOFF_MS + cfg.INDEXER_POLL_MS * 5;
            if (!at || Date.now() - at > limit) {
              throw new Error(at ? `no successful tick for ${Math.round((Date.now() - at) / 1000)} s` : 'no successful tick yet');
            }
          },
        ]),
      ),
    },
  });
  registerMetrics(health, metrics, cfg.METRICS_TOKEN ? {token: cfg.METRICS_TOKEN} : {});
  await health.listen({port: cfg.INDEXER_HEALTH_PORT!, host: '0.0.0.0'});
  logger.info({port: cfg.INDEXER_HEALTH_PORT}, 'indexer health endpoint listening');
}

await workersDone;
logger.info('indexer stopped');
