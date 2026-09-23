import {encodeFunctionData, type Abi, type Hex} from 'viem';
import type {AgentxConfig} from '@agentx/config';
import {loadAbis} from '@agentx/config';
import {AgentxError, ErrorCode} from '@agentx/shared';
import type {JobRouteDeps} from './routes/jobs.js';

/**
 * Turn an API action into a policy-checked, signed transaction.
 *
 * The API never holds a key. It encodes the call, hands it to the signer over
 * private networking, and reports what came back. That separation is what
 * makes "the API is compromised" survivable: an attacker gets to *propose*
 * transactions, and the signer's policy plus the on-chain AgentAccount caps
 * decide whether any of them happen.
 */

export interface SignerSubmitDeps {
  signerUrl: string;
  config: AgentxConfig;
  abis?: Record<string, Abi>;
  fetchImpl?: typeof fetch;
}

export function makeSignerSubmit(deps: SignerSubmitDeps): JobRouteDeps['submit'] {
  const abis = deps.abis ?? (loadAbis() as unknown as Record<string, Abi>);
  const escrowAbi = abis['TaskEscrow'];
  if (!escrowAbi) throw new Error('TaskEscrow ABI missing — run `make export` in agentx-contracts');
  const doFetch = deps.fetchImpl ?? fetch;

  return async ({agentId, chainId, kind, job, spend, idempotencyKey, payload}) => {
    const chain = deps.config.chain(chainId);
    const escrow = chain.contracts['TaskEscrow'];
    if (!escrow) {
      throw new AgentxError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${chainId} has no deployed TaskEscrow`);
    }

    const data = encodeCall(escrowAbi, kind, {agentId, job, spend, payload, chain});

    const res = await doFetch(`${deps.signerUrl}/sign`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        agentId,
        chainId,
        target: escrow,
        data,
        spend: spend.toString(),
        idempotencyKey,
      }),
    });

    if (!res.ok) {
      // The signer already speaks RFC 7807, so its refusal is passed through
      // intact rather than flattened into a generic 500. An agent that hit a
      // budget cap must see BUDGET_EXCEEDED, not "signer error".
      const problem = (await res.json().catch(() => ({}))) as {code?: string; detail?: string};
      throw new AgentxError(
        (problem.code as ErrorCode) ?? ErrorCode.INSUFFICIENT_FUNDS,
        problem.detail ?? `signer refused with ${res.status}`,
      );
    }

    const {txHash} = (await res.json()) as {txHash: string};
    return {txHash};
  };
}

function encodeCall(
  abi: Abi,
  kind: Parameters<JobRouteDeps['submit']>[0]['kind'],
  ctx: {
    agentId: number;
    job: {id: number; chainJobId: string | null} | undefined;
    spend: bigint;
    payload: Record<string, unknown> | undefined;
    chain: ReturnType<AgentxConfig['chain']>;
  },
): Hex {
  const chainJobId = ctx.job?.chainJobId ? BigInt(ctx.job.chainJobId) : 0n;
  const specHash = (ctx.payload?.['specHash'] as Hex) ?? ('0x' + '0'.repeat(64) as Hex);

  // ERC-8004 ids supplied by the caller. NEVER ctx.agentId — that is the
  // database's serial, and the contract would resolve it to a different
  // agent's wallet without erroring.
  const workerAgentId = BigInt(String(ctx.payload?.['workerChainAgentId'] ?? 0));
  const clientAgentId = BigInt(String(ctx.payload?.['clientChainAgentId'] ?? 0));

  switch (kind) {
    case 'directPay':
      return encodeFunctionData({
        abi,
        functionName: 'directPay',
        args: [clientAgentId, workerAgentId, ctx.spend, specHash],
      });

    case 'createJob':
      return encodeFunctionData({
        abi,
        functionName: 'createJob',
        args: [
          clientAgentId,
          workerAgentId,
          ctx.spend,
          specHash,
          BigInt(ctx.chain.params.acceptWindowSeconds as number),
          BigInt(ctx.chain.params.workWindowSeconds as number),
        ],
      });

    case 'accept':
      return encodeFunctionData({abi, functionName: 'acceptJob', args: [chainJobId]});

    case 'submitResult':
      return encodeFunctionData({
        abi,
        functionName: 'submitResult',
        args: [chainJobId, (ctx.payload?.['resultHash'] as Hex) ?? specHash, ''],
      });

    case 'approve':
      return encodeFunctionData({abi, functionName: 'approve', args: [chainJobId]});

    case 'dispute':
      return encodeFunctionData({
        abi,
        functionName: 'dispute',
        args: [chainJobId, (ctx.payload?.['reasonHash'] as Hex) ?? specHash],
      });

    case 'cancel':
      return encodeFunctionData({abi, functionName: 'cancel', args: [chainJobId]});

    default: {
      // Exhaustiveness: adding a new action without an encoding is a compile
      // error, not a transaction that quietly does nothing.
      const never: never = kind;
      throw new Error(`unhandled action ${String(never)}`);
    }
  }
}
