import {describe, expect, it} from 'vitest';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '@agentx/config';
import {makeSignerSubmit} from '../src/submit.js';

/** The API's half of the signer handshake: it must present the token it was given. */
describe('calling the signer', () => {
  const config = loadConfig({
    contractsRoot: fileURLToPath(new URL('../../../../agentx-contracts', import.meta.url)),
    env: {ENABLED_CHAIN_IDS: '31337', DEFAULT_CHAIN_ID: '31337'},
  });

  const capture = () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({txHash: '0x' + 'ab'.repeat(32)}), {status: 200});
    }) as unknown as typeof fetch;
    return {seen, fetchImpl};
  };

  const call = (submit: ReturnType<typeof makeSignerSubmit>) =>
    submit({
      agentId: 1,
      chainId: 31337,
      kind: 'accept',
      job: {chainJobId: '7'} as never,
      spend: 0n,
      idempotencyKey: 'submit-test-1',
      payload: {},
    } as never);

  it('presents the token when it has one', async () => {
    const {seen, fetchImpl} = capture();
    await call(makeSignerSubmit({signerUrl: 'http://signer', signerToken: 'tok', config, fetchImpl}));
    expect(seen[0]!['authorization']).toBe('Bearer tok');
  });

  it('sends no authorization header when it has none', async () => {
    const {seen, fetchImpl} = capture();
    await call(makeSignerSubmit({signerUrl: 'http://signer', config, fetchImpl}));
    expect(seen[0]!['authorization']).toBeUndefined();
  });
});
