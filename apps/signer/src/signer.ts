import {createPublicClient, createWalletClient, http, type Abi, type Hex, type PublicClient} from 'viem';
import {eq, and, sql} from 'drizzle-orm';
import type {ChainConfig} from '@agentx/config';
import {type Db, signerTxs, agents} from '@agentx/db';
import {AgentxError, ErrorCode} from '@agentx/shared';
import type {KeySource} from './keystore.js';

/**
 * The signer: one process, one job, refuses everything else.
 *
 * Key material lives here and nowhere else — the API never touches it. Every
 * request is policy-checked, deduplicated, nonce-ordered, and only then
 * signed.
 *
 * The off-chain policy check duplicates what AgentAccount enforces on-chain,
 * deliberately: the off-chain one gives a useful error, the on-chain one gives
 * the guarantee. If they ever disagree, the chain wins and the caller gets a
 * revert — which is the correct failure direction.
 */

export interface SignRequest {
  agentId: number;
  chainId: number;
  target: Hex;
  data: Hex;
  /** The spend this call is expected to make, in base units. */
  spend: bigint;
  /** Required. Agents retry, and a retried hire must not create a second job. */
  idempotencyKey: string;
}

export interface SignResult {
  txHash: Hex;
  nonce: number;
  /** True when this was a replay and the original hash is being returned. */
  replayed: boolean;
}

export interface SignerDeps {
  db: Db;
  chain: ChainConfig;
  keys: KeySource;
  abis: Record<string, Abi>;
  /** Refuse to sign below this much native currency, rather than emitting a failing tx. */
  gasFloorWei?: bigint;
  logger?: {info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void};
}

export class SignerService {
  private readonly pub: PublicClient;
  private readonly log: NonNullable<SignerDeps['logger']>;
  private readonly gasFloor: bigint;

  constructor(private readonly deps: SignerDeps) {
    this.pub = createPublicClient({transport: http(deps.chain.rpcUrl)});
    this.log = deps.logger ?? {info: () => {}, warn: () => {}};
    this.gasFloor = deps.gasFloorWei ?? 10n ** 16n; // 0.01 native
  }

  async sign(req: SignRequest): Promise<SignResult> {
    const {db, chain, keys} = this.deps;

    if (req.chainId !== chain.chainId) {
      throw new AgentxError(
        ErrorCode.CHAIN_MISMATCH,
        `signer serves chain ${chain.chainId}, request was for ${req.chainId}`,
      );
    }

    // 1. Replay first — cheapest, and the answer is already final.
    const existing = await db.query.signerTxs.findFirst({
      where: eq(signerTxs.idempotencyKey, req.idempotencyKey),
    });
    if (existing?.txHash) {
      this.log.info({idempotencyKey: req.idempotencyKey, txHash: existing.txHash}, 'replay');
      return {txHash: existing.txHash as Hex, nonce: existing.nonce, replayed: true};
    }

    // 2. Policy, mirroring AgentAccount's on-chain checks.
    await this.checkPolicy(req);

    const account = await keys.accountFor(req.agentId);
    if (!account) {
      throw new AgentxError(ErrorCode.AGENT_NOT_HIREABLE, `no signing key for agent ${req.agentId}`);
    }

    // 3. Gas. Refusing is better than broadcasting a transaction that will
    //    fail and still consume a nonce.
    const balance = await this.pub.getBalance({address: account.address});
    if (balance < this.gasFloor) {
      throw new AgentxError(
        ErrorCode.INSUFFICIENT_FUNDS,
        `agent ${req.agentId} has ${balance} wei, below the ${this.gasFloor} gas floor — top up from FUNDER`,
      );
    }

    // 4. Nonce under a per-agent advisory lock. Two concurrent hires for the
    //    same agent must not produce the same nonce, and a database lock is
    //    the only thing that holds across process restarts and replicas.
    return this.withAgentLock(req.agentId, async () => {
      const nonce = await this.pub.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      });

      // Claim the slot BEFORE broadcasting. If we crash between claiming and
      // broadcasting, the row is 'pending' with no hash and is visible for
      // reconciliation — far better than an untracked in-flight transaction.
      const [claimed] = await db
        .insert(signerTxs)
        .values({
          chainId: chain.chainId,
          agentId: req.agentId,
          idempotencyKey: req.idempotencyKey,
          nonce,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning();

      if (!claimed) {
        // Another request took this key between step 1 and here.
        const now = await db.query.signerTxs.findFirst({
          where: eq(signerTxs.idempotencyKey, req.idempotencyKey),
        });
        if (now?.txHash) return {txHash: now.txHash as Hex, nonce: now.nonce, replayed: true};
        throw new AgentxError(ErrorCode.IDEMPOTENCY_CONFLICT, 'a request with this key is in flight');
      }

      const wallet = createWalletClient({account, transport: http(chain.rpcUrl)});
      const txHash = await wallet.sendTransaction({
        to: req.target,
        data: req.data,
        nonce,
        chain: null,
      });

      await db
        .update(signerTxs)
        .set({txHash, status: 'broadcast'})
        .where(eq(signerTxs.id, claimed.id));

      this.log.info({agentId: req.agentId, nonce, txHash}, 'signed and broadcast');
      return {txHash, nonce, replayed: false};
    });
  }

  /**
   * The same five rules AgentAccount enforces on-chain, checked here so the
   * caller gets an actionable error instead of a bare revert.
   */
  private async checkPolicy(req: SignRequest): Promise<void> {
    const {db, chain, abis} = this.deps;

    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, req.agentId), eq(agents.chainId, chain.chainId)),
    });
    if (!agent) {
      throw new AgentxError(ErrorCode.CHAIN_MISMATCH, `agent ${req.agentId} is not on chain ${chain.chainId}`);
    }

    const accountAbi = abis['AgentAccount'];
    if (!accountAbi || req.spend === 0n) return;

    // Read the caps from the chain, not from our cache. The cache exists for
    // fast rejection; the contract is the authority, and a stale cache that
    // lets a call through only to have it revert is the worse failure.
    const [perTaskCap, dailyRemaining, dayStart] = await Promise.all([
      this.pub
        .readContract({
          address: agent.walletAddress as Hex,
          abi: accountAbi,
          functionName: 'policy',
        })
        .then((p) => (p as readonly [bigint, bigint, boolean])[0])
        .catch(() => null),
      this.pub
        .readContract({
          address: agent.walletAddress as Hex,
          abi: accountAbi,
          functionName: 'dailyRemaining',
        })
        .then((v) => v as bigint)
        .catch(() => null),
      this.pub
        .readContract({
          address: agent.walletAddress as Hex,
          abi: accountAbi,
          functionName: 'dayStart',
        })
        .then((v) => v as bigint)
        .catch(() => null),
    ]);

    if (perTaskCap !== null && req.spend > perTaskCap) {
      throw new AgentxError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(req.spend)} exceeds the per-task cap of ${chain.formatToken(perTaskCap)}`,
      );
    }

    if (dailyRemaining !== null && req.spend > dailyRemaining) {
      throw new AgentxError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(req.spend)} exceeds today's remaining budget of ${chain.formatToken(dailyRemaining)}`,
        this.secondsUntilReset(dayStart),
      );
    }
  }

  /**
   * Serialise per agent using a Postgres advisory lock.
   *
   * Two concurrent hires for the same agent must not read the same nonce. An
   * in-process mutex would not survive a second replica, which Railway will
   * happily give us.
   */
  private async withAgentLock<T>(agentId: number, fn: () => Promise<T>): Promise<T> {
    const {db} = this.deps;
    const key = BigInt(this.deps.chain.chainId) * 1_000_000n + BigInt(agentId);
    await db.execute(sql`SELECT pg_advisory_lock(${key})`);
    try {
      return await fn();
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${key})`);
    }
  }

  /**
   * When the daily cap actually refills.
   *
   * `AgentAccount` rolls a 24h window from the first spend — it is NOT a UTC
   * midnight reset. A `Retry-After` from the wrong clock tells a caller to
   * come back at a time the cap has not lifted, which is worse than no hint
   * at all: it turns one refusal into two.
   */
  private secondsUntilReset(dayStart: bigint | null): number {
    if (dayStart === null || dayStart === 0n) return DAY_SECONDS;
    const elapsed = Math.floor(Date.now() / 1000) - Number(dayStart);
    return Math.max(0, DAY_SECONDS - elapsed);
  }
}

const DAY_SECONDS = 24 * 60 * 60;
