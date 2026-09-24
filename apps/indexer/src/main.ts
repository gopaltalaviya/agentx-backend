import pino from 'pino';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb} from '@agentx/db';
import {Indexer} from './indexer.js';
import {runIndexerLoop} from './loop.js';

/**
 * One indexer worker per enabled chain, all in one process.
 *
 * Running testnet and mainnet together is a config value, not a second
 * deployment — `ENABLED_CHAIN_IDS=10143,143` and both are watched.
 */
const logger = pino({level: process.env['LOG_LEVEL'] ?? 'info'});

const config = loadConfig();
const abis = loadAbis() as Record<string, never>;
const db = createDb(process.env['DATABASE_URL']!);

const POLL_MS = Number(process.env['INDEXER_POLL_MS'] ?? 2_000);
const MAX_BACKOFF_MS = Number(process.env['INDEXER_MAX_BACKOFF_MS'] ?? 60_000);

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

const workers = Object.values(config.chains).map((chain) => {
  const indexer = new Indexer({db, chain, abis, logger});
  logger.info({chainId: chain.chainId, name: chain.name, startBlock: chain.startBlock}, 'indexer started');

  return runIndexerLoop(() => indexer.tick(), {
    pollMs: POLL_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    signal: controller.signal,
    onError: (err, failures, nextDelayMs) => {
      // Escalate with persistence. One failed tick is noise on any public
      // RPC; twenty in a row is an outage someone needs to see, and logging
      // both at the same level means neither gets noticed.
      const line = {
        chainId: chain.chainId,
        err: (err as Error).message,
        failures,
        retryingInMs: nextDelayMs,
      };
      failures >= 5 ? logger.error(line, 'indexer is failing') : logger.warn(line, 'tick failed, retrying');
    },
    onRecovered: (afterFailures) =>
      logger.info({chainId: chain.chainId, afterFailures}, 'indexer recovered'),
  });
});

await Promise.all(workers);
logger.info('indexer stopped');
