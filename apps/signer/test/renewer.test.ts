import {describe, expect, it} from 'vitest';
import {Renewer, type RenewerDeps} from '../src/renewer.js';

/**
 * `AgentAccount` caps a session key at 24 hours (`MAX_SESSION_KEY_TTL`), and
 * only the account's OWNER may grant one. A hosted orchestrator therefore
 * stopped hiring a day after it was set up: nothing renewed its key. The
 * renewer holds the owner key and re-grants what is about to lapse.
 */

const OWNER = '0x00000000000000000000000000000000000000aa';
const STRANGER = '0x00000000000000000000000000000000000000bb';
const ORCH = '0x0000000000000000000000000000000000000001';
const WORKER = '0x0000000000000000000000000000000000000002';
const OTHERS = '0x0000000000000000000000000000000000000003';
const HOT = '0x00000000000000000000000000000000000000c1';
const WKEY = '0x00000000000000000000000000000000000000c2';
const NOW = 1_000_000n;
const H = 3_600n;

type Grant = {expiry: bigint; budget: bigint};

function world(over: Partial<RenewerDeps> = {}) {
  const grants = new Map<string, Grant>([
    [`${ORCH}:${HOT}`, {expiry: NOW + 2n * H, budget: 1_000_000n}], // due (within 6 h)
    [`${WORKER}:${WKEY}`, {expiry: NOW + 20n * H, budget: 0n}], // not due
    [`${OTHERS}:${HOT}`, {expiry: NOW + 1n * H, budget: 5n}], // due, but not our account
  ]);
  const sent: {account: string; key: string; expiry: bigint; budget: bigint}[] = [];
  const deps: RenewerDeps = {
    owner: OWNER,
    keys: [HOT, WKEY],
    renewBeforeSeconds: 6n * H,
    ttlSeconds: 23n * H,
    accounts: async () => [ORCH, WORKER, OTHERS],
    ownerOf: async (a) => (a === OTHERS ? STRANGER : OWNER),
    grantOf: async (a, k) => grants.get(`${a}:${k}`) ?? {expiry: 0n, budget: 0n},
    now: async () => NOW,
    grant: async (account, key, expiry, budget) => {
      sent.push({account, key, expiry, budget});
      return '0xhash';
    },
    ...over,
  };
  return {deps, sent};
}

describe('session-key renewal', () => {
  it('renews only a grant that lapses within the window, to now + 23 h, keeping its budget', async () => {
    const {deps, sent} = world();
    const result = await new Renewer(deps).renew();
    expect(sent).toEqual([{account: ORCH, key: HOT, expiry: NOW + 23n * H, budget: 1_000_000n}]);
    expect(result.renewed).toHaveLength(1);
  });

  it('never touches an account it does not own, or a key the account never granted', async () => {
    const {deps, sent} = world();
    await new Renewer(deps).renew();
    expect(sent.some((s) => s.account === OTHERS)).toBe(false);
    expect(sent.some((s) => s.account === WORKER && s.key === HOT)).toBe(false);
  });

  it('renews a grant that has ALREADY lapsed — the service may have been down', async () => {
    const {deps, sent} = world({
      grantOf: async (a, k) =>
        a === ORCH && k === HOT ? {expiry: NOW - H, budget: 7n} : {expiry: 0n, budget: 0n},
    });
    await new Renewer(deps).renew();
    expect(sent).toEqual([{account: ORCH, key: HOT, expiry: NOW + 23n * H, budget: 7n}]);
  });

  it('skips a wallet that is not an AgentAccount (owner() cannot be read)', async () => {
    const {deps, sent} = world({
      ownerOf: async (a) => {
        if (a === WORKER) throw new Error('execution reverted');
        return a === OTHERS ? STRANGER : OWNER;
      },
    });
    await new Renewer(deps).renew();
    expect(sent.map((s) => s.account)).toEqual([ORCH]);
  });

  it('one failed grant does not stop the others', async () => {
    let first = true;
    const {deps, sent} = world({
      grantOf: async () => ({expiry: NOW + H, budget: 1n}), // every grant due
      grant: async (account, key, expiry, budget) => {
        if (first) {
          first = false;
          throw new Error('nonce too low');
        }
        sent.push({account, key, expiry, budget});
        return '0xhash';
      },
    });
    const result = await new Renewer(deps).renew();
    expect(result.failed).toHaveLength(1);
    expect(result.renewed.length).toBeGreaterThan(0);
  });

  it('compares owners case-insensitively (checksummed vs lowercase addresses)', async () => {
    const {deps, sent} = world({ownerOf: async () => OWNER.toUpperCase().replace('0X', '0x')});
    await new Renewer(deps).renew();
    expect(sent.length).toBeGreaterThan(0);
  });
});
