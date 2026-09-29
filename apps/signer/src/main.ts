import Fastify from 'fastify';
import pino from 'pino';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb} from '@agentx/db';
import {AgentxError} from '@agentx/shared';
import {EnvKeystoreSource, RawKeySource, type KeySource} from './keystore.js';
import {SignerService} from './signer.js';
import {chainKeeper} from './keeper.js';
import {authorised, bindHost} from './auth.js';
import {privateKeyToAccount} from 'viem/accounts';

/**
 * The signer is NOT a public service.
 *
 * On Railway it binds to private networking only; the API reaches it at the
 * internal hostname. Exposing it publicly would put an unauthenticated
 * signing endpoint on the internet.
 */
const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  // Key material must never reach a log line, even by accident.
  redact: ['req.body.privateKey', 'req.headers.authorization', 'SIGNER_KEYSTORE_JSON', 'SIGNER_KEYSTORE_PASSPHRASE', 'KEEPER_PRIVATE_KEY', 'SIGNER_TOKEN'],
});

const config = loadConfig();
const abis = loadAbis() as Record<string, never>;
const db = createDb(process.env['DATABASE_URL']!);

const chain = config.chain();

let keys: KeySource;
if (process.env['SIGNER_KEYSTORE_JSON']) {
  keys = new EnvKeystoreSource();
  logger.info({kind: keys.kind, chainId: chain.chainId}, 'keys loaded');
} else {
  // Raw keys are permitted on a testnet only, and the constructor enforces it.
  keys = new RawKeySource(process.env, chain.testnet);
  logger.warn({kind: keys.kind, chainId: chain.chainId}, 'using a raw development key');
}

const service = new SignerService({db, chain, keys, abis, logger});
const app = Fastify({logger: false});

app.get('/health', async () => ({ok: true, chainId: chain.chainId, keys: keys.kind}));

app.post('/sign', async (request, reply) => {
  if (!authorised(request.headers.authorization, process.env['SIGNER_TOKEN'])) {
    return reply.status(401).send({code: 'UNAUTHORIZED', detail: 'the signer requires its SIGNER_TOKEN'});
  }
  const body = request.body as Record<string, unknown>;
  try {
    const result = await service.sign({
      agentId: Number(body['agentId']),
      chainId: Number(body['chainId'] ?? chain.chainId),
      target: body['target'] as `0x${string}`,
      data: body['data'] as `0x${string}`,
      spend: BigInt(String(body['spend'] ?? '0')),
      idempotencyKey: String(body['idempotencyKey']),
    });
    return result;
  } catch (err) {
    if (err instanceof AgentxError) {
      const problem = err.toProblem('Signing refused');
      return reply.status(problem.status).send(problem);
    }
    logger.warn({err: (err as Error).message}, 'sign failed');
    return reply.status(500).send({code: 'SIGNER_ERROR', detail: (err as Error).message});
  }
});

// The keeper sends the escrow's permissionless exits when they fall due —
// without it, a worker that vanishes after accepting strands the client's
// money. It runs here because this is the process allowed to hold a key, but
// on a key of its own: sharing the signer's would race it for nonces.
const keeperKey = process.env['KEEPER_PRIVATE_KEY'];
if (keeperKey) {
  if (!chain.testnet) throw new Error('KEEPER_PRIVATE_KEY is a raw key; raw keys are for testnet only');
  const keeper = chainKeeper({db, chain, abis, account: privateKeyToAccount(keeperKey as `0x${string}`), logger});
  keeper.start(Number(process.env['KEEPER_INTERVAL_MS'] ?? 15_000));
  logger.info({chainId: chain.chainId}, 'keeper sweeping for due exits');
} else {
  logger.warn('no KEEPER_PRIVATE_KEY: expired escrow jobs will wait for someone else to exit them');
}

const port = Number(process.env['SIGNER_PORT'] ?? 7070);
const host = bindHost(process.env);
await app.listen({port, host});
logger.info({port, host, chainId: chain.chainId, token: Boolean(process.env['SIGNER_TOKEN'])}, 'signer listening');
