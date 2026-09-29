import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Abi,
  type Account,
  type Hex,
  type PublicClient,
} from 'viem';
import {and, eq, gte, isNull, sql} from 'drizzle-orm';
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
    const capsOnChain = await this.checkPolicy(req);

    // The agent's registered wallet — the address the CHAIN will check.
    //
    // `TaskEscrow` resolves a job's worker and client through the identity
    // registry and compares the result to `msg.sender`. So the key is not a
    // detail of custody: it IS the agent's identity, and the keystore has to
    // be told which address it must produce.
    const agent = await this.loadAgent(req.agentId);
    const wallet = agent.walletAddress as Hex;

    // Two kinds of wallet, two ways to sign.
    //
    // An AgentAccount is a contract: the call goes TO the account as
    // `execute(target, data)`, signed by its owner or a session key it has
    // granted, and the account makes the call — so `msg.sender` at the escrow
    // is the account, the registered wallet, and the caps are enforced by the
    // account itself, on chain. A plain EOA signs for itself.
    let account: Account | null;
    let to: Hex = req.target;
    let data: Hex = req.data;

    if (capsOnChain) {
      account = await this.keyTrustedBy(wallet);
      if (!account) {
        throw new AgentxError(
          ErrorCode.AGENT_NOT_HIREABLE,
          `agent ${req.agentId}'s wallet ${wallet} is an AgentAccount, and no key held here is its owner ` +
            'or an unexpired session key — the owner must grant one',
        );
      }
      to = wallet;
      data = encodeFunctionData({abi: EXECUTE_ABI, functionName: 'execute', args: [req.target, req.data]});
    } else {
      account = await keys.accountFor(req.agentId, wallet);
      if (!account) {
        throw new AgentxError(ErrorCode.AGENT_NOT_HIREABLE, `no signing key for agent ${req.agentId}`);
      }

      // Signing with somebody else's key produces a transaction that is valid,
      // costs gas, and reverts — `NotAgentWallet`, surfaced as "execution
      // reverted for an unknown reason" because the revert data is a custom
      // error. A single shared dev key made that the outcome of every accept,
      // submitResult and approve in the system. Refusing here says which two
      // addresses disagree, before any gas is spent.
      if (account.address.toLowerCase() !== wallet.toLowerCase()) {
        throw new AgentxError(
          ErrorCode.AGENT_NOT_HIREABLE,
          `agent ${req.agentId} is registered to wallet ${wallet}, but the only key available signs as ` +
            `${account.address} — the chain checks msg.sender against the registered wallet, so this would revert`,
        );
      }
    }
    const signer = account;

    // 3. Gas. Refusing is better than broadcasting a transaction that will
    //    fail and still consume a nonce.
    const balance = await this.pub.getBalance({address: signer.address});
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
        address: signer.address,
        blockTag: 'pending',
      });

      // A failed broadcast that never reached the chain still holds its
      // nonce in our ledger, and the next request — given that same nonce by
      // the node — collided with it and was refused as "in flight". The
      // chain's own pending count proves such a nonce was never used (had
      // the transaction reached even the mempool, the count would be past
      // it), so the stale claim is released. A retry of that request simply
      // claims a fresh slot.
      await db
        .delete(signerTxs)
        .where(
          and(
            eq(signerTxs.chainId, chain.chainId),
            eq(signerTxs.agentId, req.agentId),
            eq(signerTxs.status, 'failed'),
            isNull(signerTxs.txHash),
            gte(signerTxs.nonce, nonce),
          ),
        );

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

      let slot = claimed;

      if (!slot) {
        const now = await db.query.signerTxs.findFirst({
          where: eq(signerTxs.idempotencyKey, req.idempotencyKey),
        });
        if (now?.txHash) return {txHash: now.txHash as Hex, nonce: now.nonce, replayed: true};

        // A previous attempt claimed the key and then failed to broadcast —
        // the wallet was out of gas, or the RPC was down.
        //
        // Without this the key is burned forever: the row exists, has no
        // hash, and every retry is refused as "in flight". Topping the wallet
        // up would not help, which is the opposite of the recovery the chaos
        // checklist asks for.
        //
        // The retry REUSES THE STORED NONCE. If the original somehow did
        // reach the mempool after all, two transactions with one nonce means
        // only one can ever be mined — so recovering cannot double-spend.
        if (now && now.status === 'failed') {
          const [reclaimed] = await db
            .update(signerTxs)
            .set({status: 'pending'})
            .where(eq(signerTxs.id, now.id))
            .returning();
          slot = reclaimed;
          this.log.warn({agentId: req.agentId, nonce: now.nonce}, 'retrying a failed broadcast');
        }
      }

      if (!slot) {
        // Another request holds this key right now.
        throw new AgentxError(ErrorCode.IDEMPOTENCY_CONFLICT, 'a request with this key is in flight');
      }

      // No AgentAccount, so nothing on-chain will stop this spend: the cap
      // is ours to hold. Reserved here — under the lock, after a replay has
      // already returned, before anything is broadcast — so two concurrent
      // hires cannot both fit into the same remaining budget.
      const reserved = !capsOnChain && req.spend > 0n;
      if (reserved) {
        try {
          await this.reserveOffChain(req.agentId, req.spend);
        } catch (err) {
          // Free the key: a spend refused today may be allowed tomorrow.
          await db.update(signerTxs).set({status: 'failed'}).where(eq(signerTxs.id, slot.id));
          throw err;
        }
      }

      const client = createWalletClient({account: signer, transport: http(chain.rpcUrl)});

      let txHash: Hex;
      try {
        txHash = await client.sendTransaction({
          // For an AgentAccount this is the account, carrying execute(...).
          to,
          data,
          // The slot's nonce, which on a retry is the original one.
          nonce: slot.nonce,
          chain: null,
        });
      } catch (err) {
        // Nothing left the building, so nothing was spent.
        if (reserved) await this.releaseOffChain(req.agentId, req.spend).catch(() => undefined);

        // Record the failure rather than leaving the row 'pending' forever,
        // so the key can be retried once whatever broke is fixed.
        await db
          .update(signerTxs)
          .set({status: 'failed'})
          .where(eq(signerTxs.id, slot.id))
          .catch(() => undefined);

        // The caller gets a sentence; the log keeps the whole error. A live
        // run once failed as "Missing or invalid parameters" and nothing
        // anywhere recorded what the node had actually said.
        const e = err as {shortMessage?: string; details?: string; message?: string};
        this.log.warn(
          {agentId: req.agentId, to, signer: signer.address, short: e.shortMessage, details: e.details, message: e.message?.slice(0, 2000)},
          'broadcast failed',
        );
        throw asActionableError(err, chain.network.nativeCurrency.symbol, signer.address);
      }

      await db
        .update(signerTxs)
        .set({txHash, status: 'broadcast'})
        .where(eq(signerTxs.id, slot.id));

      this.log.info({agentId: req.agentId, nonce: slot.nonce, txHash}, 'signed and broadcast');
      return {txHash, nonce: slot.nonce, replayed: false};
    });
  }

  /**
   * The same five rules AgentAccount enforces on-chain, checked here so the
   * caller gets an actionable error instead of a bare revert.
   */
  /** The agent row, or an actionable error naming the chain it is not on. */
  private async loadAgent(agentId: number) {
    const {db, chain} = this.deps;
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.chainId, chain.chainId)),
    });
    if (!agent) {
      throw new AgentxError(ErrorCode.CHAIN_MISMATCH, `agent ${agentId} is not on chain ${chain.chainId}`);
    }
    return agent;
  }

  /**
   * The on-chain caps, where the wallet is an AgentAccount.
   *
   * Returns whether the chain holds this agent's caps. When it does not — a
   * plain EOA, which is every agent today — the caller must enforce the
   * stored policy itself, because nothing else will.
   */
  private async checkPolicy(req: SignRequest): Promise<boolean> {
    const {chain, abis} = this.deps;

    const agent = await this.loadAgent(req.agentId);

    const accountAbi = abis['AgentAccount'];
    // Read even when nothing is spent: whether the wallet IS an account
    // decides how every call is signed — approve, dispute and cancel spend
    // nothing and still have to go through it.
    if (!accountAbi) return false;

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

    return perTaskCap !== null && dailyRemaining !== null;
  }

  /**
   * A key held here that this AgentAccount will accept: its owner, or a
   * session key it granted that has not expired. Asked of the account every
   * time rather than cached — a revoke must take effect on the next call.
   */
  private async keyTrustedBy(wallet: Hex): Promise<Account | null> {
    const held = this.deps.keys.all?.() ?? [];
    if (held.length === 0) return null;

    const owner = await this.pub
      .readContract({address: wallet, abi: ACCOUNT_KEYS_ABI, functionName: 'owner'})
      .catch(() => null);
    const now = BigInt(Math.floor(Date.now() / 1000));

    // Prefer a session key: bounded in time and budget, which is the point.
    // The owner's key is the fallback, and on a real deployment is not here.
    let ownerKey: Account | null = null;
    for (const key of held) {
      const [expiry] = await this.pub
        .readContract({address: wallet, abi: ACCOUNT_KEYS_ABI, functionName: 'sessionKeys', args: [key.address]})
        .catch(() => [0n, 0n, 0n] as const);
      // A minute of margin: a key that expires while its transaction is in
      // the mempool reverts, and costs gas doing it.
      if (expiry > now + 60n) return key;
      if (owner && owner.toLowerCase() === key.address.toLowerCase()) ownerKey = key;
    }
    return ownerKey;
  }

  /**
   * Check and reserve a spend against the stored policy, atomically.
   *
   * One UPDATE decides and records: the window rolls over after 24 hours
   * (rolling, like AgentAccount's, not UTC midnight), the per-task cap and
   * the daily cap are both tested, and if either fails no row changes.
   */
  private async reserveOffChain(agentId: number, spend: bigint): Promise<void> {
    const {db, chain} = this.deps;
    const amount = spend.toString();
    const rows = (await db.execute(sql`
      UPDATE spend_policies SET
        spent_today = CASE WHEN day_start <= now() - interval '24 hours'
                           THEN ${amount}::numeric ELSE spent_today + ${amount}::numeric END,
        day_start   = CASE WHEN day_start <= now() - interval '24 hours' THEN now() ELSE day_start END
      WHERE agent_id = ${agentId}
        AND per_task_cap >= ${amount}::numeric
        AND (CASE WHEN day_start <= now() - interval '24 hours' THEN 0 ELSE spent_today END)
            + ${amount}::numeric <= daily_cap
      RETURNING agent_id
    `)) as unknown as {agent_id: number}[];
    if (rows.length > 0) return;

    // Refused. Say which rule, and when it lifts.
    const [policy] = (await db.execute(sql`
      SELECT per_task_cap, daily_cap, spent_today,
             GREATEST(0, EXTRACT(EPOCH FROM (day_start + interval '24 hours' - now())))::int AS resets_in
      FROM spend_policies WHERE agent_id = ${agentId}
    `)) as unknown as {per_task_cap: string; daily_cap: string; spent_today: string; resets_in: number}[];

    if (!policy) {
      throw new AgentxError(
        ErrorCode.BUDGET_EXCEEDED,
        `agent ${agentId} has no spending policy — nothing may be spent until one is set`,
      );
    }
    if (spend > BigInt(policy.per_task_cap)) {
      throw new AgentxError(
        ErrorCode.BUDGET_EXCEEDED,
        `spend ${chain.formatToken(spend)} exceeds the per-task cap of ${chain.formatToken(BigInt(policy.per_task_cap))}`,
      );
    }
    const remaining = BigInt(policy.daily_cap) - BigInt(policy.spent_today);
    throw new AgentxError(
      ErrorCode.BUDGET_EXCEEDED,
      `spend ${chain.formatToken(spend)} exceeds today's remaining budget of ${chain.formatToken(remaining > 0n ? remaining : 0n)}`,
      Math.max(1, policy.resets_in),
    );
  }

  private async releaseOffChain(agentId: number, spend: bigint): Promise<void> {
    await this.deps.db.execute(sql`
      UPDATE spend_policies SET spent_today = GREATEST(0, spent_today - ${spend.toString()}::numeric)
      WHERE agent_id = ${agentId}
    `);
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

/** AgentAccount.execute — the only way a call leaves an account. */
const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      {name: 'target', type: 'address'},
      {name: 'data', type: 'bytes'},
    ],
    outputs: [{name: 'result', type: 'bytes'}],
  },
] as const;

/** Who an AgentAccount will take a call from. */
const ACCOUNT_KEYS_ABI = [
  {type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{name: '', type: 'address'}]},
  {
    type: 'function',
    name: 'sessionKeys',
    stateMutability: 'view',
    inputs: [{name: 'key', type: 'address'}],
    outputs: [
      {name: 'expiry', type: 'uint64'},
      {name: 'budget', type: 'uint128'},
      {name: 'spent', type: 'uint128'},
    ],
  },
] as const;

/**
 * Turn a broadcast failure into something the operator can act on.
 *
 * "execution reverted" and a 900-character viem stack are the same thing to
 * whoever is watching a demo fail: unreadable. The two that actually happen —
 * an empty gas wallet and an unreachable RPC — get a sentence each, naming
 * the address to fund, because at that moment the useful output is an
 * address and not a stack trace.
 */
function asActionableError(err: unknown, gasSymbol: string, from: string): AgentxError {
  const message = err instanceof Error ? err.message : String(err);
  // Classify on what the node SAID, not on viem's full message: that carries
  // the whole request body, and "503" inside a transaction's hex once turned
  // an empty gas wallet into "the RPC endpoint is unreachable".
  const e = err as {shortMessage?: string; details?: string};
  const said = [e.shortMessage, e.details].filter(Boolean).join(' ') || message;

  if (/insufficient (funds|balance)|exceeds the balance|gas required exceeds/i.test(said)) {
    return new AgentxError(
      ErrorCode.INSUFFICIENT_FUNDS,
      `the agent wallet ${from} has no ${gasSymbol} left for gas — top it up and retry the same request`,
    );
  }

  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|socket hang up|\b50[234]\b/i.test(said)) {
    return new AgentxError(
      ErrorCode.CHAIN_NOT_ENABLED,
      `the RPC endpoint is unreachable — the transaction was NOT broadcast, so retrying the same request is safe (${message})`,
      5,
    );
  }

  return new AgentxError(ErrorCode.INVALID_STATE, `broadcast failed: ${message}`);
}
