import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Hex,
  type PublicClient,
} from 'viem';
import {eq} from 'drizzle-orm';
import type {ChainConfig} from '@agentx/config';
import {agents, type Db} from '@agentx/db';
import type {Metrics} from '@agentx/service';

/**
 * The renewer: keeps the session keys of accounts it owns from lapsing.
 *
 * `AgentAccount` lets a hot key spend only through a SESSION key, and caps
 * every grant at 24 hours (`MAX_SESSION_KEY_TTL`) — a stolen hot key is
 * useless by tomorrow. The cost of that rule is that something must renew the
 * grant every day, and only the account's OWNER may. A hosted orchestrator
 * with nobody renewing stopped hiring a day after it was set up.
 *
 * It holds the owner key of the hosted accounts — never the deployer's, and
 * never a key the signer signs agent calls with (two processes drawing nonces
 * from one account race). It renews only grants the account already made,
 * keeps each grant's budget, and leaves any account it does not own alone.
 * The chain decides: grants and owners are read on every pass.
 */

export interface RenewerDeps {
  /** The renewer's own address — the owner it acts as. */
  owner: string;
  /** Held keys that may hold grants (the signer's session keys). */
  keys: string[];
  /** Renew a grant that lapses within this many seconds. */
  renewBeforeSeconds: bigint;
  /** New grants run this long. Under the contract's 24 h maximum. */
  ttlSeconds: bigint;
  /** Candidate accounts: registered agents' wallets. */
  accounts: () => Promise<string[]>;
  /** The account's owner; throws for a wallet that is not an AgentAccount. */
  ownerOf: (account: string) => Promise<string>;
  /** The account's grant to `key`; expiry 0 = never granted. */
  grantOf: (account: string, key: string) => Promise<{expiry: bigint; budget: bigint}>;
  now: () => Promise<bigint>;
  grant: (account: string, key: string, expiry: bigint, budget: bigint) => Promise<string>;
  onRenew?: (outcome: 'renewed' | 'failed') => void;
  logger?: {info: (o: object, m: string) => void; warn: (o: object, m: string) => void};
}

export interface RenewResult {
  checked: number;
  renewed: {account: string; key: string; expiry: string; txHash: string}[];
  failed: {account: string; key: string; reason: string}[];
}

export class Renewer {
  private readonly log: NonNullable<RenewerDeps['logger']>;

  constructor(private readonly deps: RenewerDeps) {
    this.log = deps.logger ?? {info: () => {}, warn: () => {}};
  }

  async renew(): Promise<RenewResult> {
    const result: RenewResult = {checked: 0, renewed: [], failed: []};
    const me = this.deps.owner.toLowerCase();
    const now = await this.deps.now();

    for (const account of await this.deps.accounts()) {
      let owner: string;
      try {
        owner = await this.deps.ownerOf(account);
      } catch {
        continue; // a plain wallet, not an AgentAccount
      }
      if (owner.toLowerCase() !== me) continue;
      result.checked++;

      for (const key of this.deps.keys) {
        const {expiry, budget} = await this.deps.grantOf(account, key);
        if (expiry === 0n) continue; // never granted: not ours to create
        if (expiry > now + this.deps.renewBeforeSeconds) continue;

        const next = now + this.deps.ttlSeconds;
        try {
          const txHash = await this.deps.grant(account, key, next, budget);
          result.renewed.push({account, key, expiry: next.toString(), txHash});
          this.deps.onRenew?.('renewed');
          this.log.info({account, key, expiry: next.toString(), txHash}, 'session key renewed');
        } catch (err) {
          const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
          result.failed.push({account, key, reason});
          this.deps.onRenew?.('failed');
          this.log.warn({account, key, reason}, 'session key not renewed');
        }
      }
    }
    return result;
  }

  /** Renew forever. Returns a function that stops it. */
  start(intervalMs: number): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const loop = async () => {
      try {
        await this.renew();
      } catch (err) {
        this.log.warn({reason: (err as Error).message}, 'renewal pass failed');
      }
      if (!stopped) timer = setTimeout(() => void loop(), intervalMs);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}

/** Wire a renewer to a real chain and database. */
export function chainRenewer(opts: {
  db: Db;
  chain: ChainConfig;
  abis: Record<string, Abi>;
  /** The owner of the accounts to keep alive. */
  account: Account;
  /** Addresses of the session keys the signer holds. */
  keys: string[];
  renewBeforeSeconds: number;
  logger?: RenewerDeps['logger'];
  /** Exported as `session_renewals_total{outcome}` when given. */
  metrics?: Metrics;
}): Renewer {
  const {db, chain, abis, account} = opts;
  const pub = createPublicClient({transport: http(chain.rpcUrl)}) as PublicClient;
  const wallet = createWalletClient({account, transport: http(chain.rpcUrl)});
  const abi = abis['AgentAccount'] as Abi;
  const renewals = opts.metrics?.counter(
    'session_renewals_total',
    'Session-key grants the renewer re-sent or failed to',
    ['outcome'],
  );

  return new Renewer({
    owner: account.address,
    keys: opts.keys,
    renewBeforeSeconds: BigInt(opts.renewBeforeSeconds),
    ttlSeconds: 23n * 3600n,
    ...(opts.logger ? {logger: opts.logger} : {}),
    ...(renewals ? {onRenew: (outcome) => renewals.labels(outcome).inc()} : {}),
    accounts: async () =>
      (
        await db.select({wallet: agents.walletAddress}).from(agents).where(eq(agents.chainId, chain.chainId))
      ).map((r) => r.wallet),
    ownerOf: async (a) => (await pub.readContract({address: a as Hex, abi, functionName: 'owner'})) as string,
    grantOf: async (a, key) => {
      const [expiry, budget] = (await pub.readContract({
        address: a as Hex,
        abi,
        functionName: 'sessionKeys',
        args: [key as Hex],
      })) as readonly [bigint, bigint, bigint];
      return {expiry, budget};
    },
    now: async () => (await pub.getBlock({blockTag: 'latest'})).timestamp,
    grant: async (a, key, expiry, budget) => {
      // Simulate first: a refusal costs a read, not gas.
      const {request} = await pub.simulateContract({
        account,
        address: a as Hex,
        abi,
        functionName: 'grantSessionKey',
        args: [key as Hex, expiry, budget],
      });
      const hash = await wallet.writeContract({...request, chain: null});
      const receipt = await pub.waitForTransactionReceipt({hash});
      if (receipt.status !== 'success') throw new Error(`grantSessionKey reverted in ${hash}`);
      return hash;
    },
  });
}
