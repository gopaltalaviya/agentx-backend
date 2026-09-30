import type {FastifyInstance} from 'fastify';
import {eq} from 'drizzle-orm';
import {indexerCursor, type Db} from '@agentx/db';
import type {ChainConfig} from '@agentx/config';
import {withTimeout, type BuildInfo} from '@agentx/service';

/**
 * `GET /v1/status` — is AGENTX working, in terms a public status page can show.
 *
 * `/health` says the process is up and `/ready` whether a load balancer should
 * send it traffic; neither says whether the marketplace is actually current.
 * The indexer is what turns on-chain settlements into what the site shows, and
 * an indexer that is up but hours behind looked identical to a healthy one.
 *
 * Everything here is PUBLIC, so it is states and numbers only: never an error
 * message (a driver error names the host it could not reach; an RPC error can
 * carry a keyed URL), never a hostname, URL or key. The reason a check failed
 * goes to the log, where the operator is.
 *
 * It is also cheap by construction: one result is cached for `cacheMs` and
 * shared by every concurrent caller, so a burst of page loads is one database
 * query and one RPC call per chain, and each check is bounded by `timeoutMs`,
 * so a hanging RPC makes the answer "rpc: down", not a hanging request.
 */

export type ComponentStatus = 'up' | 'degraded' | 'down' | 'unknown';

export interface StatusDeps {
  /** Resolves when the signer answers its /health. Omitted: 'unknown'. */
  signer?: () => Promise<unknown>;
  /** The chain head, per chain. Omitted: 'unknown'. */
  headBlock?: (chainId: number) => Promise<bigint>;
  /** Blocks the indexer may trail the head before it is 'degraded'. Default 150. */
  maxIndexerLagBlocks?: number;
  /** How long one result is reused. Default 5000 ms; 0 disables. */
  cacheMs?: number;
  /** Per-check bound. Default 2000 ms. */
  timeoutMs?: number;
}

interface ChainStatus {
  chainId: number;
  name: string;
  testnet: boolean;
  rpc: ComponentStatus;
  headBlock: number | null;
  indexer: {
    status: ComponentStatus;
    indexedBlock: number | null;
    lagBlocks: number | null;
    lastIndexedAt: string | null;
    secondsSinceIndexed: number | null;
  };
}

export interface StatusReport {
  status: 'operational' | 'degraded' | 'down';
  checkedAt: string;
  build: BuildInfo | null;
  components: {
    api: ComponentStatus;
    database: ComponentStatus;
    signer: ComponentStatus;
    rpc: ComponentStatus;
    indexer: ComponentStatus;
  };
  chains: ChainStatus[];
}

const RANK: Record<ComponentStatus, number> = {up: 0, unknown: 1, degraded: 2, down: 3};
const worst = (all: ComponentStatus[]): ComponentStatus =>
  all.reduce<ComponentStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), 'up');

export function registerStatusRoutes(
  app: FastifyInstance,
  deps: {db: Db; chains: Record<number, ChainConfig>; build?: BuildInfo; status?: StatusDeps},
): void {
  const opts = deps.status ?? {};
  const cacheMs = opts.cacheMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const maxLag = opts.maxIndexerLagBlocks ?? 150;

  /** Run one check; log why it failed, report only that it did. */
  const probe = async <T>(
    name: string,
    run: () => Promise<T>,
  ): Promise<{ok: true; value: T} | {ok: false}> => {
    try {
      return {
        ok: true,
        value: await withTimeout(run(), timeoutMs, `${name} did not answer within ${timeoutMs} ms`),
      };
    } catch (err) {
      app.log.warn({err, check: name}, 'status check failed');
      return {ok: false};
    }
  };

  async function compute(): Promise<StatusReport> {
    const chainIds = Object.keys(deps.chains).map(Number);

    const [cursors, signer, heads] = await Promise.all([
      probe('database', () =>
        deps.db.select().from(indexerCursor).where(eq(indexerCursor.contract, 'TaskEscrow')),
      ),
      opts.signer ? probe('signer', opts.signer) : Promise.resolve(null),
      Promise.all(
        chainIds.map((id) =>
          opts.headBlock ? probe(`rpc-${id}`, () => opts.headBlock!(id)) : Promise.resolve(null),
        ),
      ),
    ]);

    const now = Date.now();
    const chains: ChainStatus[] = chainIds.map((chainId, i) => {
      const chain = deps.chains[chainId]!;
      const head = heads[i] ?? null;
      const headBlock = head?.ok ? Number(head.value) : null;
      const rpc: ComponentStatus = head === null ? 'unknown' : head.ok ? 'up' : 'down';

      const cursor = cursors.ok ? cursors.value.find((c) => Number(c.chainId) === chainId) : undefined;
      const indexedBlock = cursor ? Number(cursor.lastBlock) : null;
      const lagBlocks =
        indexedBlock !== null && headBlock !== null ? Math.max(0, headBlock - indexedBlock) : null;
      const updated = cursor ? new Date(cursor.updatedAt) : null;

      const indexer: ComponentStatus =
        lagBlocks === null ? 'unknown' : lagBlocks > maxLag + chain.confirmations ? 'degraded' : 'up';

      return {
        chainId,
        name: chain.name,
        testnet: chain.testnet,
        rpc,
        headBlock,
        indexer: {
          status: indexer,
          indexedBlock,
          lagBlocks,
          lastIndexedAt: updated ? updated.toISOString() : null,
          secondsSinceIndexed: updated ? Math.max(0, Math.round((now - updated.getTime()) / 1000)) : null,
        },
      };
    });

    const database: ComponentStatus = cursors.ok ? 'up' : 'down';
    const components = {
      api: 'up' as const,
      database,
      signer: (signer === null ? 'unknown' : signer.ok ? 'up' : 'down') as ComponentStatus,
      rpc: worst(chains.map((c) => c.rpc)),
      indexer: worst(chains.map((c) => c.indexer.status)),
    };

    // Without the database the API can serve nothing; anything else short of
    // 'up' — including a component nobody can vouch for — is degraded.
    const status =
      database === 'down'
        ? ('down' as const)
        : Object.values(components).every((s) => s === 'up')
          ? ('operational' as const)
          : ('degraded' as const);

    return {status, checkedAt: new Date(now).toISOString(), build: deps.build ?? null, components, chains};
  }

  let cached: {at: number; report: Promise<StatusReport>} | null = null;

  app.get('/v1/status', async (_request, reply) => {
    const now = Date.now();
    if (!cached || cacheMs <= 0 || now - cached.at >= cacheMs) {
      cached = {at: now, report: compute()};
    }
    reply.header('cache-control', `public, max-age=${Math.floor(cacheMs / 1000)}`);
    return cached.report;
  });
}
