import Fastify from 'fastify';
import pino from 'pino';
import {loadConfig, loadAbis} from '@agentx/config';
import {createDb} from '@agentx/db';
import {AgentxError} from '@agentx/shared';
import {EnvKeystoreSource, RawKeySource, type KeySource} from './keystore.js';
import {SignerService} from './signer.js';

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
  redact: ['req.body.privateKey', 'SIGNER_KEYSTORE_JSON', 'SIGNER_KEYSTORE_PASSPHRASE'],
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

const port = Number(process.env['SIGNER_PORT'] ?? 7070);
await app.listen({port, host: '0.0.0.0'});
logger.info({port, chainId: chain.chainId}, 'signer listening (private networking only)');
