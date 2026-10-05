import {createPublicClient, http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {loadConfig, loadAbis} from '@agentx/config';
import {closeDb, closeLockPool, createDb, createLockPool} from '@agentx/db';
import {buildInfo, createMetrics, env, installShutdown, loadEnv, serviceLogger} from '@agentx/service';
import {buildSignerApp} from './app.js';
import {EnvKeystoreSource, RawKeySource, type KeySource} from './keystore.js';
import {SignerService} from './signer.js';
import {chainKeeper} from './keeper.js';
import {chainRenewer} from './renewer.js';
import {bindHost} from './auth.js';

/**
 * The signer is NOT a public service.
 *
 * On Railway it binds to private networking only; the API reaches it at the
 * internal hostname. Without SIGNER_TOKEN it binds to loopback and refuses to
 * listen anywhere wider (see auth.ts).
 */
const Env = z.object({
  DATABASE_URL: env.postgresUrl(),
  SIGNER_PORT: env.port(7070),
  SIGNER_HOST: z.string().optional(),
  SIGNER_TOKEN: z.string().min(32, 'SIGNER_TOKEN must be at least 32 characters').optional(),
  SIGNER_KEYSTORE_JSON: z.string().optional(),
  KEEPER_PRIVATE_KEY: env.privateKey().optional(),
  KEEPER_INTERVAL_MS: env.positiveInt(15_000),
  /** Owner of the hosted AgentAccounts: renews their 24 h session keys. Testnet only. */
  SESSION_OWNER_PRIVATE_KEY: env.privateKey().optional(),
  SESSION_RENEW_INTERVAL_MS: env.positiveInt(3_600_000),
  /** Renew a grant that lapses within this many seconds. */
  SESSION_RENEW_BEFORE_S: env.positiveInt(21_600),
  METRICS_TOKEN: z.string().optional(),
  TRUST_PROXY: env.flag(),
  LOG_LEVEL: env.logLevel(),
  DB_POOL_MAX: env.positiveInt(5),
  LOCK_POOL_MAX: env.positiveInt(10),
});

const cfg = loadEnv(Env);
const logger = serviceLogger('signer', cfg.LOG_LEVEL);

const config = loadConfig();
const abis = loadAbis() as Record<string, never>;
const chain = config.chain();
const db = createDb(cfg.DATABASE_URL, {max: cfg.DB_POOL_MAX});
const locks = createLockPool(cfg.DATABASE_URL, {max: cfg.LOCK_POOL_MAX});

let keys: KeySource;
if (cfg.SIGNER_KEYSTORE_JSON) {
  keys = new EnvKeystoreSource();
  logger.info({kind: keys.kind, chainId: chain.chainId}, 'keys loaded');
} else {
  // Raw keys are permitted on a testnet only, and the constructor enforces it.
  keys = new RawKeySource(process.env, chain.testnet);
  logger.warn({kind: keys.kind, chainId: chain.chainId}, 'using a raw development key');
}

const service = new SignerService({db, locks, chain, keys, abis, logger});
const metrics = createMetrics('signer');
const pub = createPublicClient({transport: http(chain.rpcUrl)});

const app = buildSignerApp({
  service,
  chainId: chain.chainId,
  keysKind: keys.kind,
  build: buildInfo({service: 'signer', packageJsonUrl: new URL('../package.json', import.meta.url)}),
  ...(cfg.SIGNER_TOKEN ? {token: cfg.SIGNER_TOKEN} : {}),
  ...(cfg.METRICS_TOKEN ? {metricsToken: cfg.METRICS_TOKEN} : {}),
  trustProxy: cfg.TRUST_PROXY,
  metrics,
  logger,
  checks: {
    database: () => db.execute(sql`SELECT 1`),
    rpc: () => pub.getBlockNumber(),
  },
});

// The keeper sends the escrow's permissionless exits when they fall due —
// without it, a worker that vanishes after accepting strands the client's
// money. It runs here because this is the process allowed to hold a key, but
// on a key of its own: sharing the signer's would race it for nonces.
let stopKeeper: (() => void) | undefined;
if (cfg.KEEPER_PRIVATE_KEY) {
  if (!chain.testnet) throw new Error('KEEPER_PRIVATE_KEY is a raw key; raw keys are for testnet only');
  const keeper = chainKeeper({
    db,
    chain,
    abis,
    account: privateKeyToAccount(cfg.KEEPER_PRIVATE_KEY as `0x${string}`),
    logger,
    metrics,
  });
  stopKeeper = keeper.start(cfg.KEEPER_INTERVAL_MS);
  logger.info({chainId: chain.chainId}, 'keeper sweeping for due exits');
} else {
  logger.warn('no KEEPER_PRIVATE_KEY: expired escrow jobs will wait for someone else to exit them');
}

// The renewer keeps the hosted accounts' session keys alive. AgentAccount caps
// a grant at 24 h and only the OWNER may renew it, so without this a hosted
// orchestrator stops hiring a day after it was set up.
let stopRenewer: (() => void) | undefined;
if (cfg.SESSION_OWNER_PRIVATE_KEY) {
  if (!chain.testnet)
    throw new Error('SESSION_OWNER_PRIVATE_KEY is a raw key; raw keys are for testnet only');
  const held = (keys.all?.() ?? []).map((a) => a.address);
  const renewer = chainRenewer({
    db,
    chain,
    abis,
    account: privateKeyToAccount(cfg.SESSION_OWNER_PRIVATE_KEY as `0x${string}`),
    keys: held,
    renewBeforeSeconds: cfg.SESSION_RENEW_BEFORE_S,
    logger,
    metrics,
  });
  stopRenewer = renewer.start(cfg.SESSION_RENEW_INTERVAL_MS);
  logger.info({chainId: chain.chainId, keys: held.length}, 'renewer keeping session keys alive');
}

installShutdown({
  logger,
  closers: [
    ['keeper', async () => stopKeeper?.()],
    ['renewer', async () => stopRenewer?.()],
    // Stops accepting, then waits for in-flight signs to finish.
    ['http', () => app.close()],
    ['locks', () => closeLockPool(locks)],
    ['database', () => closeDb(db)],
  ],
});

const host = bindHost(process.env);
await app.listen({port: cfg.SIGNER_PORT, host});
logger.info(
  {port: cfg.SIGNER_PORT, host, chainId: chain.chainId, token: Boolean(cfg.SIGNER_TOKEN)},
  'signer listening',
);
