/**
 * Chain helpers shared by the scripts that write to a real chain.
 *
 * Two rules the v2 contracts made hard requirements, in one place:
 *
 * - An identity is registered BY ITS OWNER. v2's escrow refuses a hire when
 *   client and worker have the same owner (SameOwner), so a script that
 *   registered every agent from one key could no longer hire anything.
 * - An agent id is READ from the `Registered` event, never assumed. Assuming
 *   `nextId + i` is wrong the moment anyone else registers on a shared
 *   testnet between two of our transactions.
 */
import {keccak256, parseEventLogs, toHex} from 'viem';

/**
 * Send, surviving a dropped response: sign ONCE, then broadcast the same bytes
 * until the node has them. Re-running writeContract after a lost response
 * would sign a NEW transaction on a new nonce; the same bytes are idempotent.
 */
export async function send(pub, walletClient, request) {
  const prepared = await walletClient.prepareTransactionRequest(request);
  const raw = await walletClient.signTransaction(prepared);
  const hash = keccak256(raw);
  for (let attempt = 0; ; attempt++) {
    try {
      await pub.sendRawTransaction({serializedTransaction: raw});
      break;
    } catch (err) {
      const msg = `${err.shortMessage ?? ''} ${err.details ?? ''} ${err.message ?? ''}`;
      if (/already known|nonce too low|replacement transaction underpriced/i.test(msg)) break;
      const transient =
        err.name === 'HttpRequestError' ||
        err.name === 'TimeoutError' ||
        /\b50[234]\b|fetch failed|ECONNRESET/i.test(msg);
      if (!transient || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const receipt = await pub.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

/** Register an ERC-8004 identity AS `ownerClient`'s account; returns the new agent id. */
export async function registerAgent(pub, ownerClient, {identity, abi, uri, wallet}) {
  const {encodeFunctionData} = await import('viem');
  const receipt = await send(pub, ownerClient, {
    to: identity,
    data: encodeFunctionData({abi, functionName: 'register', args: [uri, wallet]}),
  });
  const [registered] = parseEventLogs({abi, logs: receipt.logs, eventName: 'Registered'});
  if (!registered) throw new Error(`no Registered event in ${receipt.transactionHash}`);
  return registered.args.agentId;
}

/** Top an address up to `target` wei from `payer`, if it is below it. */
export async function topUp(pub, payerClient, address, target) {
  const balance = await pub.getBalance({address});
  if (balance >= target) return null;
  return send(pub, payerClient, {to: address, value: target - balance});
}

/**
 * An ERC-8004 registration file ("agent card") as a base64 JSON data: URI —
 * the form the spec allows for fully on-chain metadata — so an identity the
 * demo registers describes its agent to anyone reading the registry, instead
 * of pointing at an address that resolves to nothing. Same shape as the
 * interface's lib/agent-card.ts (registration-v1).
 */
export function agentCardUri({name, capabilities, apiUrl, description}) {
  const card = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description: description ?? `An AGENTX agent offering ${capabilities.join(', ')}.`,
    image: '',
    services: [
      {
        name: 'AGENTX',
        endpoint: `${apiUrl.replace(/\/$/, '')}/v1/agents`,
        version: 'v1',
        skills: capabilities,
      },
    ],
    x402Support: false,
    active: true,
    registrations: [],
    supportedTrust: ['reputation'],
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(card), 'utf8').toString('base64')}`;
}

export const unique = (label) => keccak256(toHex(`${label}:${Date.now()}:${Math.random()}`));
