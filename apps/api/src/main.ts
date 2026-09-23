import pino from 'pino';
import {loadConfig} from '@agentx/config';
import {createDb} from '@agentx/db';
import {buildApp} from './app.js';
import {makeSignerSubmit} from './submit.js';
import {makeBudgetReader} from './chain-reads.js';

const logger = pino({level: process.env['LOG_LEVEL'] ?? 'info'});

const config = loadConfig();
const db = createDb(process.env['DATABASE_URL']!);

const app = await buildApp({
  db,
  chains: config.chains as Record<number, never>,
  defaultChainId: config.defaultChainId,
  readBudget: makeBudgetReader(config),
  submit: makeSignerSubmit({
    signerUrl: process.env['SIGNER_URL'] ?? 'http://127.0.0.1:7070',
    config,
  }),
  logger: true,
});

const port = Number(process.env['PORT'] ?? 8080);
await app.listen({port, host: '0.0.0.0'});
logger.info({port, chains: Object.keys(config.chains)}, 'api listening');
