import pino from 'pino';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb} from '@agentx/db';
import {Indexer} from './indexer.js';

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

const workers = Object.values(config.chains).map((chain) => {
  const indexer = new Indexer({db, chain, abis, logger});
  logger.info({chainId: chain.chainId, name: chain.name, startBlock: chain.startBlock}, 'indexer started');

  return (async () => {
    for (;;) {
      try {
        await indexer.tick();
      } catch (err) {
        // A failing tick must never kill the worker: RPCs rate-limit, time
        // out and briefly 500. The cursor is durable, so we simply retry.
        logger.warn({chainId: chain.chainId, err: (err as Error).message}, 'tick failed, retrying');
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
});

await Promise.all(workers);
