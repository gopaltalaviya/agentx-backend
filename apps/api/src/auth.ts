import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {eq, and, isNull} from 'drizzle-orm';
import type {FastifyRequest} from 'fastify';
import {type Db, apiKeys, agents} from '@agentx/db';
import {AgentxError, ErrorCode} from '@agentx/shared';

/**
 * API keys, one per agent.
 *
 * The key is shown once at creation and never stored — only a salted scrypt
 * hash is. A database dump therefore does not yield working credentials.
 *
 * scrypt from node:crypto rather than argon2id: argon2 is the better choice on
 * paper, but it needs a native build, and a native build that fails on
 * Railway the night before a deadline is a worse outcome than a slightly
 * weaker KDF on testnet keys. Recorded as a known trade-off.
 */

const SCRYPT = {N: 16_384, r: 8, p: 1, keylen: 32};

export function generateApiKey(): string {
  return `ax_${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(key, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyApiKey(key: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(key, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
  // Constant time: a length-varying or short-circuiting compare leaks the
  // hash one byte at a time to anyone willing to measure.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface Caller {
  agentId: number;
  chainId: number;
  scopes: string[];
}

/**
 * Resolve the caller from `Authorization: Bearer ax_...`.
 *
 * Every key is bound to exactly one agent, and an agent belongs to exactly one
 * chain — so authentication also fixes the chain, and a key used against
 * another network fails with CHAIN_MISMATCH rather than quietly operating on
 * the wrong one.
 */
export async function authenticate(db: Db, request: FastifyRequest): Promise<Caller> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AgentxError(ErrorCode.UNAUTHORIZED, 'missing Authorization: Bearer <api key>');
  }
  const presented = header.slice('Bearer '.length).trim();

  // Candidate set is small (keys are per-agent); scanning avoids storing a
  // reversible lookup index alongside the hash.
  const rows = await db
    .select({id: apiKeys.id, agentId: apiKeys.agentId, keyHash: apiKeys.keyHash, scopes: apiKeys.scopes})
    .from(apiKeys)
    .where(isNull(apiKeys.revokedAt));

  const match = rows.find((r) => verifyApiKey(presented, r.keyHash));
  if (!match) throw new AgentxError(ErrorCode.UNAUTHORIZED, 'unknown or revoked API key');

  const agent = await db.query.agents.findFirst({where: eq(agents.id, match.agentId)});
  if (!agent) throw new AgentxError(ErrorCode.AGENT_NOT_HIREABLE, 'the key belongs to a deleted agent');

  await db.update(apiKeys).set({lastUsedAt: new Date()}).where(eq(apiKeys.id, match.id));

  return {agentId: agent.id, chainId: agent.chainId, scopes: match.scopes};
}

/** The chain a request operates on: explicit `?chainId=`, else the caller's. */
export function resolveChainId(request: FastifyRequest, caller: Caller, enabled: number[]): number {
  const q = (request.query as {chainId?: string}).chainId;
  if (q === undefined) return caller.chainId;

  const asked = Number(q);
  if (!enabled.includes(asked)) {
    throw new AgentxError(ErrorCode.CHAIN_NOT_ENABLED, `chain ${asked} is not enabled (have ${enabled.join(',')})`);
  }
  if (asked !== caller.chainId) {
    throw new AgentxError(
      ErrorCode.CHAIN_MISMATCH,
      `this key belongs to an agent on chain ${caller.chainId}, not ${asked}`,
    );
  }
  return asked;
}

export {and};
