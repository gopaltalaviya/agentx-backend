import {createPublicClient, http, parseEventLogs, type Abi, type Hex, type PublicClient} from 'viem';
import {loadAbis, type AgentxConfig} from '@agentx/config';

/**
 * Reads of on-chain state the API reports but does not own.
 *
 * Injected rather than constructed in the route, for the same reason `submit`
 * is: a test of the budget endpoint should not need an RPC. When no reader is
 * supplied the route falls back to the cached policy and SAYS SO — an agent
 * planning a spend is entitled to know whether the number it is planning
 * against came from the chain or from our copy of it.
 */

export interface BudgetReading {
  perTaskCap: bigint;
  dailyCap: bigint;
  dailyRemaining: bigint;
  allowlistOnly: boolean;
  tokenBalance: bigint;
  /**
   * Unix seconds at which the daily window opened. The contract's window is a
   * rolling 24h from this point, NOT UTC midnight — reporting midnight would
   * tell an agent to wait for a reset that has already happened, or plan a
   * spend against a cap that has not.
   */
  dayStart: bigint;
}

export type BudgetReader = (args: {
  chainId: number;
  walletAddress: string;
}) => Promise<BudgetReading | null>;

/**
 * Real reader, against `AgentAccount`.
 *
 * Returns `null` rather than throwing when the wallet is not an AgentAccount
 * (a plain EOA has no policy) or the RPC is unreachable. A budget lookup that
 * fails should degrade to the cache, never 500 — an agent that cannot read its
 * budget will otherwise fall back to discovering it by hitting 402s, which is
 * exactly the retry storm `my_budget` exists to prevent.
 */
export function makeBudgetReader(config: AgentxConfig, abis?: Record<string, Abi>): BudgetReader {
  const loaded = abis ?? (loadAbis() as unknown as Record<string, Abi>);
  const accountAbi = loaded['AgentAccount'];
  const erc20Abi = loaded['IERC20'] ?? MINIMAL_ERC20;

  const clients = new Map<number, PublicClient>();
  const clientFor = (chainId: number): PublicClient => {
    let client = clients.get(chainId);
    if (!client) {
      client = createPublicClient({transport: http(config.chain(chainId).rpcUrl)}) as PublicClient;
      clients.set(chainId, client);
    }
    return client;
  };

  return async ({chainId, walletAddress}) => {
    if (!accountAbi) return null;
    const chain = config.chain(chainId);
    const token = chain.network.paymentToken.address;
    const address = walletAddress as Hex;
    const pub = clientFor(chainId);

    try {
      const [policy, dailyRemaining, dayStart, tokenBalance] = await Promise.all([
        pub.readContract({address, abi: accountAbi, functionName: 'policy'}) as Promise<
          readonly [bigint, bigint, boolean]
        >,
        pub.readContract({address, abi: accountAbi, functionName: 'dailyRemaining'}) as Promise<bigint>,
        pub.readContract({address, abi: accountAbi, functionName: 'dayStart'}) as Promise<bigint>,
        token
          ? (pub.readContract({
              address: token as Hex,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [address],
            }) as Promise<bigint>)
          : Promise.resolve(0n),
      ]);

      return {
        perTaskCap: policy[0],
        dailyCap: policy[1],
        allowlistOnly: policy[2],
        dailyRemaining,
        dayStart,
        tokenBalance,
      };
    } catch {
      return null;
    }
  };
}

const MINIMAL_ERC20 = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{name: 'account', type: 'address'}],
    outputs: [{name: '', type: 'uint256'}],
  },
] as const satisfies Abi;

/** An ERC-8004 identity as the registry reports it. */
export interface IdentityReading {
  owner: string;
  wallet: string;
}

export type IdentityReader = (args: {
  chainId: number;
  chainAgentId: bigint;
}) => Promise<IdentityReading | null>;

const IDENTITY_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{name: 'agentId', type: 'uint256'}],
    outputs: [{name: '', type: 'address'}],
  },
  {
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{name: 'agentId', type: 'uint256'}],
    outputs: [{name: '', type: 'address'}],
  },
] as const satisfies Abi;

/**
 * Real reader, against the chain's ERC-8004 Identity Registry.
 *
 * `null` for an id that does not exist (ownerOf reverts) — and for an
 * unreachable RPC, since a registration that cannot be verified must not be
 * recorded as verified.
 */
export function makeIdentityReader(config: AgentxConfig): IdentityReader {
  return async ({chainId, chainAgentId}) => {
    const chain = config.chain(chainId);
    const registry = chain.erc8004['identityRegistry'] as Hex | undefined;
    if (!registry) return null;
    const pub = createPublicClient({transport: http(chain.rpcUrl)});
    try {
      const [owner, wallet] = await Promise.all([
        pub.readContract({address: registry, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [chainAgentId]}),
        pub.readContract({address: registry, abi: IDENTITY_ABI, functionName: 'getAgentWallet', args: [chainAgentId]}),
      ]);
      return {owner, wallet};
    } catch {
      return null;
    }
  };
}

/** A `DirectPaid` event, as a transaction's receipt carries it. */
export interface DirectPaidLog {
  clientAgentId: bigint;
  workerAgentId: bigint;
  amount: bigint;
  specHash: string;
}

export type PaymentReading =
  | {status: 'pending'}
  | {status: 'reverted'}
  | {status: 'success'; directPaid: DirectPaidLog[]};

export type PaymentReader = (args: {chainId: number; txHash: Hex}) => Promise<PaymentReading>;

const DIRECT_PAID_ABI = [
  {
    type: 'event',
    name: 'DirectPaid',
    inputs: [
      {name: 'jobId', type: 'uint256', indexed: true},
      {name: 'clientAgentId', type: 'uint256', indexed: true},
      {name: 'workerAgentId', type: 'uint256', indexed: true},
      {name: 'amount', type: 'uint128', indexed: false},
      {name: 'fee', type: 'uint128', indexed: false},
      {name: 'specHash', type: 'bytes32', indexed: false},
    ],
  },
] as const satisfies Abi;

/**
 * Real reader: what a payment's transaction actually did.
 *
 * An x402 receipt names a transaction, and a transaction hash proves only
 * that something was broadcast. What the worker is owed an answer to is
 * whether THE ESCROW paid THIS worker, for THIS job — so only `DirectPaid`
 * events emitted by the chain's own `TaskEscrow` are returned. The same
 * event from any other contract is a forgery with the right shape.
 *
 * No receipt yet is `pending`, not an error: Monad finalises in about a
 * second, and a worker asked a moment too early should say "retry", not
 * "unpaid". An unreachable RPC throws, because "could not check" must never
 * read as either answer.
 */
export function makePaymentReader(config: AgentxConfig): PaymentReader {
  return async ({chainId, txHash}) => {
    const chain = config.chain(chainId);
    const escrow = (chain.contracts['TaskEscrow'] as string | undefined)?.toLowerCase();
    const pub = createPublicClient({transport: http(chain.rpcUrl)});

    let receipt;
    try {
      receipt = await pub.getTransactionReceipt({hash: txHash});
    } catch (err) {
      if (err instanceof Error && err.name === 'TransactionReceiptNotFoundError') return {status: 'pending'};
      throw err;
    }
    if (receipt.status !== 'success') return {status: 'reverted'};

    const directPaid = parseEventLogs({
      abi: DIRECT_PAID_ABI,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === escrow),
      eventName: 'DirectPaid',
    }).map((e) => ({
      clientAgentId: e.args.clientAgentId,
      workerAgentId: e.args.workerAgentId,
      amount: e.args.amount,
      specHash: e.args.specHash,
    }));
    return {status: 'success', directPaid};
  };
}
