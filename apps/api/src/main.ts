import pino from 'pino';
import {loadConfig} from '@agentx/config';
import {createDb} from '@agentx/db';
import {buildApp} from './app.js';
import {makeSignerSubmit} from './submit.js';
import {makeBudgetReader, makeIdentityReader, makePaymentReader} from './chain-reads.js';
import {makeRunExecutor} from './run-executor.js';

const logger = pino({level: process.env['LOG_LEVEL'] ?? 'info'});

const config = loadConfig();
const db = createDb(process.env['DATABASE_URL']!);

const port = Number(process.env['PORT'] ?? 8080);

// Resolved before the server starts: a deployment with no model key still
// serves the marketplace, and `/health` says plainly whether it can run.
const runExecutor = await makeRunExecutor({
  baseUrl: process.env['AGENTX_SELF_URL'] ?? `http://127.0.0.1:${port}`,
  chainId: config.defaultChainId,
}).catch(() => null);

const app = await buildApp({
  db,
  chains: config.chains as Record<number, never>,
  defaultChainId: config.defaultChainId,
  readBudget: makeBudgetReader(config),
  readIdentity: makeIdentityReader(config),
  readPayment: makePaymentReader(config),
  corsOrigins: (process.env['CORS_ORIGINS'] ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  ...(runExecutor ? {runExecutor} : {}),
  submit: makeSignerSubmit({
    signerUrl: process.env['SIGNER_URL'] ?? 'http://127.0.0.1:7070',
    ...(process.env['SIGNER_TOKEN'] ? {signerToken: process.env['SIGNER_TOKEN']} : {}),
    config,
  }),
  logger: true,
});

await app.listen({port, host: '0.0.0.0'});
logger.info(
  {port, chains: Object.keys(config.chains), orchestrator: Boolean(runExecutor)},
  'api listening',
);
