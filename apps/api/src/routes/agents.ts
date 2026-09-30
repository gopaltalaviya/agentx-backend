import type {FastifyInstance} from 'fastify';
import {and, eq, lte, gte, sql} from 'drizzle-orm';
import {z} from 'zod';
import {agents, agentCapabilities, agentStats, apiKeys, spendPolicies, type Db} from '@agentx/db';
import {AgentxError, BaseUnits, Capability, ErrorCode} from '@agentx/shared';
import type {ChainConfig} from '@agentx/config';
import {authenticate, generateApiKey, hashApiKey, resolveChainId} from '../auth.js';
import {rank, RANK_MODES, type RankMode} from '../ranking.js';
import type {AgentRow} from '../types.js';
import type {IdentityReader} from '../chain-reads.js';

const RegisterBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(1_000).optional(),
  capabilities: z.array(Capability).min(1).max(16),
  pricePerTask: BaseUnits,
  endpointUrl: z.string().url().optional(),
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  ownerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chainId: z.number().int().optional(),
  /** The ERC-8004 id, when the identity is already registered. Verified on-chain before it is stored. */
  chainAgentId: z.string().regex(/^\d+$/).optional(),
});

const DiscoverQuery = z.object({
  capability: Capability.optional(),
  maxPrice: BaseUnits.optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  rank: z.enum(['balanced', 'quality', 'cheapest', 'fastest']).default('balanced'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  chainId: z.coerce.number().int().optional(),
});

export interface RouteDeps {
  db: Db;
  chains: Record<number, ChainConfig>;
  defaultChainId: number;
  readIdentity?: IdentityReader;
}

export async function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const {db, chains, defaultChainId} = deps;
  const enabled = Object.keys(chains).map(Number);

  /**
   * Discovery.
   *
   * Unauthenticated on purpose: a marketplace nobody can browse without
   * credentials is not a marketplace. It is always chain-scoped, or results
   * from two networks would silently mix.
   */
  app.get('/v1/agents', async (request) => {
    const q = DiscoverQuery.parse(request.query);
    const chainId = q.chainId ?? defaultChainId;
    if (!enabled.includes(chainId)) {
      throw new AgentxError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }
    const chain = chains[chainId]!;

    const conditions = [eq(agents.chainId, chainId), eq(agents.active, true)];
    if (q.maxPrice) conditions.push(lte(agents.pricePerTask, q.maxPrice));
    if (q.minScore !== undefined) conditions.push(gte(agentStats.score, q.minScore));

    const rows = await db
      .select({
        id: agents.id,
        chainId: agents.chainId,
        chainAgentId: agents.chainAgentId,
        name: agents.name,
        description: agents.description,
        walletAddress: agents.walletAddress,
        ownerAddress: agents.ownerAddress,
        pricePerTask: agents.pricePerTask,
        stake: agents.stake,
        active: agents.active,
        endpointUrl: agents.endpointUrl,
        score: agentStats.score,
        completed: agentStats.completed,
        failed: agentStats.failed,
        lastActiveAt: agentStats.lastActiveAt,
        capabilities: sql<string[]>`coalesce(array_agg(distinct ${agentCapabilities.capability})
          filter (where ${agentCapabilities.capability} is not null), '{}')`,
      })
      .from(agents)
      .leftJoin(agentStats, eq(agentStats.agentId, agents.id))
      .leftJoin(agentCapabilities, eq(agentCapabilities.agentId, agents.id))
      .where(and(...conditions))
      .groupBy(agents.id, agentStats.agentId)
      .limit(500);

    const filtered = q.capability
      ? rows.filter((r) => (r.capabilities as string[]).includes(q.capability!))
      : rows;

    const ranked = rank(filtered as AgentRow[], q.rank as RankMode).slice(0, q.limit);

    return {
      chainId,
      network: chain.name,
      rank: q.rank,
      agents: ranked.map((a) => present(a, chain)),
    };
  });

  app.get('/v1/agents/:id', async (request) => {
    const {id} = request.params as {id: string};
    const row = await db
      .select({
        id: agents.id,
        chainId: agents.chainId,
        chainAgentId: agents.chainAgentId,
        name: agents.name,
        description: agents.description,
        walletAddress: agents.walletAddress,
        ownerAddress: agents.ownerAddress,
        pricePerTask: agents.pricePerTask,
        stake: agents.stake,
        active: agents.active,
        endpointUrl: agents.endpointUrl,
        score: agentStats.score,
        completed: agentStats.completed,
        failed: agentStats.failed,
        lastActiveAt: agentStats.lastActiveAt,
      })
      .from(agents)
      .leftJoin(agentStats, eq(agentStats.agentId, agents.id))
      .where(eq(agents.id, Number(id)))
      .limit(1);

    const agent = row[0];
    if (!agent) throw new AgentxError(ErrorCode.AGENT_NOT_HIREABLE, `no agent ${id}`);

    const caps = await db
      .select({capability: agentCapabilities.capability})
      .from(agentCapabilities)
      .where(eq(agentCapabilities.agentId, agent.id));

    const chain = chains[agent.chainId];
    if (!chain) throw new AgentxError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${agent.chainId} is not enabled`);

    return present({...agent, capabilities: caps.map((c) => c.capability)} as AgentRow, chain);
  });

  /**
   * Register an agent.
   *
   * The on-chain ERC-8004 registration and the stake are done by the owner's
   * own wallet; this records the off-chain half (capabilities, endpoint,
   * searchable price) and issues the API key.
   *
   * `chainAgentId` links the two, and without it the agent can never be
   * hired: the escrow addresses agents by their ERC-8004 id. This used to say
   * the id "stays NULL until the indexer observes the registration", but the
   * indexer only watches TaskEscrow, so nothing ever set it — every agent
   * registered through the API or the /register page was unhireable, and only
   * the demo scripts worked, by writing the column with raw SQL.
   *
   * So the caller names the id and the chain confirms it: the id must exist,
   * be owned by `ownerAddress`, and pay out to `walletAddress`. The database
   * still never claims an on-chain fact the chain has not confirmed.
   */
  app.post('/v1/agents', async (request, reply) => {
    const body = RegisterBody.parse(request.body);
    const chainId = body.chainId ?? defaultChainId;
    if (!enabled.includes(chainId)) {
      throw new AgentxError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} is not enabled`);
    }

    if (body.chainAgentId !== undefined) {
      await verifyIdentity(deps.readIdentity, chainId, BigInt(body.chainAgentId), body);
    }

    const created = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          chainId,
          ownerAddress: body.ownerAddress.toLowerCase(),
          walletAddress: body.walletAddress.toLowerCase(),
          name: body.name,
          description: body.description ?? null,
          endpointUrl: body.endpointUrl ?? null,
          pricePerTask: body.pricePerTask,
          chainAgentId: body.chainAgentId ?? null,
        })
        .returning();

      await tx.insert(agentCapabilities).values(
        body.capabilities.map((capability) => ({agentId: agent!.id, capability})),
      );
      await tx.insert(agentStats).values({agentId: agent!.id});

      // A starting spend policy, from this chain's configured defaults.
      //
      // Without it an agent registers with no policy row at all, and
      // /v1/budget falls back to the cache, finds nothing, and reports zero —
      // so an orchestrator refuses to hire anybody and the marketplace does
      // not work at all for a new agent. Meanwhile the signer, reading a
      // wallet that is a plain EOA rather than an AgentAccount, enforces
      // nothing. Those two disagreeing is worse than either alone.
      //
      // The on-chain caps still win wherever an AgentAccount exists; this is
      // the floor for everyone else.
      await tx.insert(spendPolicies).values({
        agentId: agent!.id,
        perTaskCap: String(chains[chainId]!.params.defaultPerTaskCap),
        dailyCap: String(chains[chainId]!.params.defaultDailyCap),
      });

      const {key, keyId} = generateApiKey();
      await tx.insert(apiKeys).values({
        agentId: agent!.id,
        keyId,
        keyHash: hashApiKey(key),
        scopes: ['client', 'worker'],
      });

      return {agent: agent!, key};
    });

    return reply.status(201).send({
      agentId: created.agent.id,
      chainId,
      walletAddress: created.agent.walletAddress,
      // Shown exactly once. Only a hash is stored, so it cannot be recovered.
      apiKey: created.key,
      warning: 'Store this key now — it is not recoverable.',
    });
  });

  app.patch('/v1/agents/:id', async (request) => {
    const caller = await authenticate(db, request);
    const {id} = request.params as {id: string};
    if (Number(id) !== caller.agentId) {
      throw new AgentxError(ErrorCode.FORBIDDEN, 'an API key may only modify its own agent');
    }
    resolveChainId(request, caller, enabled);

    const patch = z
      .object({pricePerTask: BaseUnits.optional(), active: z.boolean().optional(), description: z.string().max(1000).optional()})
      .parse(request.body);

    const [updated] = await db
      .update(agents)
      .set({
        ...(patch.pricePerTask !== undefined ? {pricePerTask: patch.pricePerTask} : {}),
        ...(patch.active !== undefined ? {active: patch.active} : {}),
        ...(patch.description !== undefined ? {description: patch.description} : {}),
      })
      .where(eq(agents.id, caller.agentId))
      .returning();

    return {agentId: updated!.id, pricePerTask: updated!.pricePerTask, active: updated!.active};
  });

  app.get('/v1/rank-modes', async () => ({modes: RANK_MODES}));
}

/** Every response states its chain, so a client never has to infer it. */
function present(a: AgentRow, chain: ChainConfig) {
  const completed = Number(a.completed ?? 0);
  const failed = Number(a.failed ?? 0);
  const n = completed + failed;
  return {
    agentId: a.id,
    chainId: a.chainId,
    network: chain.name,
    chainAgentId: a.chainAgentId,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities ?? [],
    pricePerTask: a.pricePerTask,
    priceDisplay: chain.formatToken(BigInt(a.pricePerTask)),
    walletAddress: a.walletAddress,
    score: Number(a.score ?? 50),
    completed,
    failed,
    successRate: n === 0 ? null : Number((completed / n).toFixed(4)),
    active: a.active,
    explorerUrl: chain.explorerAddress(a.walletAddress),
  };
}

/**
 * Refuse an on-chain id the chain does not back.
 *
 * The owner check stops anyone claiming an identity — and the reputation
 * attached to it — by naming its id; the wallet check is what the escrow pays,
 * so a mismatch would send every payment somewhere other than where the
 * registrant thinks.
 */
async function verifyIdentity(
  read: IdentityReader | undefined,
  chainId: number,
  chainAgentId: bigint,
  body: {ownerAddress: string; walletAddress: string},
): Promise<void> {
  if (!read) {
    throw new AgentxError(
      ErrorCode.INVALID_STATE,
      'this API cannot read the identity registry, so it cannot verify chainAgentId — register without it',
    );
  }
  const identity = await read({chainId, chainAgentId});
  if (!identity) {
    throw new AgentxError(ErrorCode.INVALID_STATE, `ERC-8004 identity ${chainAgentId} does not exist on chain ${chainId}`);
  }
  if (identity.owner.toLowerCase() !== body.ownerAddress.toLowerCase()) {
    throw new AgentxError(
      ErrorCode.INVALID_STATE,
      `ERC-8004 identity ${chainAgentId} is owned by ${identity.owner}, not ${body.ownerAddress}`,
    );
  }
  if (identity.wallet.toLowerCase() !== body.walletAddress.toLowerCase()) {
    throw new AgentxError(
      ErrorCode.INVALID_STATE,
      `ERC-8004 identity ${chainAgentId} pays out to ${identity.wallet}, not ${body.walletAddress}`,
    );
  }
}
