import type {FastifyInstance} from 'fastify';
import {eq} from 'drizzle-orm';
import {agents, spendPolicies, type Db} from '@agentx/db';
import type {ChainConfig} from '@agentx/config';
import {authenticate, resolveChainId} from '../auth.js';
import type {BudgetReader} from '../chain-reads.js';

/**
 * The two endpoints an autonomous agent needs before it spends anything:
 * what network am I on, and what am I allowed to spend.
 *
 * Both exist because of the same failure. Without `/v1/budget` an agent
 * discovers its cap by hitting 402s, and an agent that retries on 402 is a
 * retry storm. Without `/v1/network` an agent cannot tell testnet play money
 * from real money — which is not a distinction to leave implicit in a system
 * that hands models a wallet.
 */

export interface MetaRouteDeps {
  db: Db;
  chains: Record<number, ChainConfig>;
  defaultChainId: number;
  readBudget?: BudgetReader;
}

export async function registerMetaRoutes(app: FastifyInstance, deps: MetaRouteDeps): Promise<void> {
  const {db, chains, defaultChainId, readBudget} = deps;
  const enabled = Object.keys(chains).map(Number);

  /** Public: a client should be able to check the network before holding a key. */
  app.get('/v1/network', async (request) => {
    const asked = (request.query as {chainId?: string}).chainId;
    const chainId = asked === undefined ? defaultChainId : Number(asked);
    const chain = chains[chainId] ?? chains[defaultChainId]!;

    return {
      chainId: chain.chainId,
      name: chain.name,
      shortName: chain.network.shortName,
      /** The field that matters most to an agent about to spend. */
      testnet: chain.testnet,
      nativeCurrency: chain.network.nativeCurrency,
      paymentToken: {
        symbol: chain.network.paymentToken.symbol,
        decimals: chain.network.paymentToken.decimals,
        address: chain.network.paymentToken.address,
      },
      contracts: chain.contracts,
      erc8004: {
        ...chain.erc8004,
        /**
         * Which registry ABI this chain has.
         *
         * The reference implementation takes `register(uri, wallet)`; the
         * canonical registry takes `register(uri)` and resolves the payout
         * wallet separately. A client that guesses wrong sends a transaction
         * that reverts, and on mainnet it pays for the privilege — so the
         * network states it rather than leaving it to be inferred from a
         * chain id.
         */
        referenceImplementation: chain.network.erc8004.deployWithProtocol,
      },
      /**
       * The PUBLIC endpoints from networks.json — deliberately not
       * `chain.rpcUrl`, which `RPC_URL_<chainId>` may have replaced with a
       * keyed private endpoint. Publishing the resolved value would hand that
       * key to every browser that loads the page.
       *
       * A browser needs these to add the chain to a wallet: Monad is in no
       * wallet's default list.
       */
      rpcUrls: chain.network.rpcUrls,
      explorerBaseUrl: chain.network.blockExplorerUrls[0] ?? null,
      faucetUrls: chain.network.faucetUrls,
      confirmations: chain.confirmations,
      /** Windows an agent must plan against, in seconds. */
      windows: {
        accept: Number(chain.params.acceptWindowSeconds),
        work: Number(chain.params.workWindowSeconds),
        review: Number(chain.params.reviewWindowSeconds),
      },
      fastPathMax: String(chain.params.fastPathMax),
      fastPathMaxDisplay: chain.formatToken(chain.params.fastPathMax as bigint),
      protocolFeeBps: Number(chain.params.protocolFeeBps),
      enabledChains: enabled,
    };
  });

  /**
   * What the caller may still spend.
   *
   * The chain is the authority — `AgentAccount` is what will actually revert —
   * so a live read wins and the cached policy is the fallback. Which one
   * answered is reported in `source`, because "0.20 left" from a stale cache
   * and "0.20 left" from the contract are not the same claim.
   */
  app.get('/v1/budget', async (request) => {
    const caller = await authenticate(db, request);
    const chainId = resolveChainId(request, caller, enabled);
    const chain = chains[chainId]!;

    const agent = await db.query.agents.findFirst({where: eq(agents.id, caller.agentId)});
    const cached = await db.query.spendPolicies.findFirst({
      where: eq(spendPolicies.agentId, caller.agentId),
    });

    // A failing RPC must degrade to the cache, never 500. An agent that cannot
    // read its budget falls back to discovering it by being refused, which is
    // the retry storm this endpoint exists to prevent.
    const onChain = agent?.walletAddress
      ? await readBudget?.({chainId, walletAddress: agent.walletAddress}).catch(() => null)
      : null;

    const perTaskCap = onChain?.perTaskCap ?? BigInt(cached?.perTaskCap ?? '0');
    const dailyCap = onChain?.dailyCap ?? BigInt(cached?.dailyCap ?? '0');
    // The window rolls over 24 hours after it opened, as the signer's does.
    // Without this, yesterday's spending was reported as today's.
    const windowOpen = cached ? Date.now() - cached.dayStart.getTime() < DAY_MS : false;
    const spentToday = windowOpen ? BigInt(cached?.spentToday ?? '0') : 0n;
    const dailyRemaining = onChain?.dailyRemaining ?? max0(dailyCap - spentToday);

    return {
      agentId: String(caller.agentId),
      chainId,
      network: chain.name,
      testnet: chain.testnet,
      /** 'chain' is authoritative; 'cache' may be stale. Say which. */
      source: onChain ? ('chain' as const) : ('cache' as const),
      perTaskCap: perTaskCap.toString(),
      perTaskCapDisplay: chain.formatToken(perTaskCap),
      dailyCap: dailyCap.toString(),
      dailyCapDisplay: chain.formatToken(dailyCap),
      dailyRemaining: dailyRemaining.toString(),
      dailyRemainingDisplay: chain.formatToken(dailyRemaining),
      /**
       * The most a single hire can cost right now: the tighter of the two
       * caps, so an agent can compare it against a price without doing the
       * comparison itself and getting it wrong.
       */
      maxSingleSpend: min(perTaskCap, dailyRemaining).toString(),
      maxSingleSpendDisplay: chain.formatToken(min(perTaskCap, dailyRemaining)),
      allowlistOnly: onChain?.allowlistOnly ?? cached?.allowlistOnly ?? false,
      tokenBalance: onChain ? onChain.tokenBalance.toString() : null,
      tokenSymbol: chain.network.paymentToken.symbol,
      walletAddress: agent?.walletAddress ?? null,
      resetsInSeconds: resetsIn(onChain?.dayStart, cached?.dayStart, spentToday),
    };
  });
}

const max0 = (v: bigint) => (v > 0n ? v : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Seconds until the daily cap refills.
 *
 * `AgentAccount` uses a rolling 24h window from the first spend, not UTC
 * midnight. An agent told "resets in 3h" when the real answer is 19h will
 * sit and wait; told 19h when it is 3h, it will hire elsewhere at a worse
 * price. So this follows the contract's clock.
 */
function resetsIn(
  onChainDayStart: bigint | undefined,
  cachedDayStart: Date | undefined,
  spentToday: bigint,
): number {
  // On-chain, dayStart is only set by a spend. The cached row carries a
  // timestamp from the moment the agent registered, so without this an agent
  // that has spent nothing is told to wait a day for a budget it already has
  // in full.
  if (onChainDayStart === undefined && spentToday === 0n) return 0;

  const startMs =
    onChainDayStart !== undefined
      ? Number(onChainDayStart) * 1000
      : (cachedDayStart?.getTime() ?? 0);

  // A window that never opened (no spend yet) is already full.
  if (startMs === 0) return 0;
  return Math.max(0, Math.ceil((startMs + DAY_MS - Date.now()) / 1000));
}

const DAY_MS = 24 * 60 * 60 * 1000;
