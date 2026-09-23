import type {z} from 'zod';
import {AgentxClient} from '@agentx/sdk';
import {buildBrain} from './factory.js';
import {Worker, type WorkerEvent} from './worker.js';

/**
 * The boilerplate every worker process shares.
 *
 * A bot should be its capability, its output schema and a sentence about what
 * it does — nothing else. Wiring, logging and shutdown are identical across
 * all of them, and repeating them three times is three places to get shutdown
 * subtly wrong.
 */

export interface RunWorkerConfig<T> {
  capability: string;
  role: string;
  output: z.ZodType<T>;
  env?: NodeJS.ProcessEnv;
  /** Overridable so a test can run the loop without a server. */
  client?: AgentxClient;
}

export async function runWorker<T>(config: RunWorkerConfig<T>): Promise<void> {
  const env = config.env ?? process.env;
  const apiKey = env['AGENTX_API_KEY'];

  if (!apiKey && !config.client) {
    throw new Error(
      `${config.capability}: AGENTX_API_KEY is not set — register this agent and export its key`,
    );
  }

  const client =
    config.client ??
    new AgentxClient({
      baseUrl: env['AGENTX_API_URL'] ?? 'http://127.0.0.1:8080',
      apiKey: apiKey!,
      ...(env['AGENTX_CHAIN_ID'] ? {chainId: Number(env['AGENTX_CHAIN_ID'])} : {}),
    });

  const worker = new Worker({
    client,
    brain: buildBrain({role: 'worker', env}),
    capability: config.capability,
    role: config.role,
    output: config.output,
    log: logEvent(config.capability),
  });

  // One controller for both signals: a demo that leaves three worker
  // processes running after Ctrl-C is a demo that fails its second rehearsal.
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => controller.abort());
  }

  const network = await client.network().catch(() => null);
  log(
    `${config.capability} ready` +
      (network ? ` — ${network.name}${network.testnet ? ' (testnet)' : ' (REAL FUNDS)'}` : ''),
  );

  await worker.run({
    intervalMs: Number(env['WORKER_POLL_MS'] ?? 1_000),
    signal: controller.signal,
  });

  log(`${config.capability} stopped`);
}

/**
 * One line per event, on stderr.
 *
 * stderr because a worker may later be run as an MCP stdio server, where
 * stdout is the transport. Deciding that once, here, is cheaper than
 * discovering it during a demo.
 */
function logEvent(capability: string): (event: WorkerEvent) => void {
  return (event) => {
    switch (event.kind) {
      case 'offer':
        return log(`[${capability}] offer ${event.jobId}`);
      case 'declined':
        return log(
          `[${capability}] declined ${event.jobId} (${event.structural ? 'cannot produce' : 'judgement'}): ${event.reason}`,
        );
      case 'accepted':
        return log(`[${capability}] accepted ${event.jobId}`);
      case 'delivered':
        return log(
          `[${capability}] delivered ${event.jobId} via ${event.provider} in ${event.latencyMs}ms`,
        );
      case 'failed':
        return log(`[${capability}] FAILED ${event.jobId} at ${event.stage}: ${event.reason}`);
    }
  };
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}
