import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * AGENTX database schema.
 *
 * The chain is the source of truth for money; this is a queryable projection
 * plus the off-chain payloads. Two rules run through all of it:
 *
 * 1. **Money is NUMERIC(38,0)** — integer base units, never float, never
 *    bigint. A uint128 amount exceeds 2^53, so a JS number would lose
 *    precision and the first symptom would be a payment that fails to
 *    reconcile.
 *
 * 2. **Every chain-derived table carries `chain_id`, and every uniqueness
 *    constraint is scoped to it.** Agent #42 on testnet and agent #42 on
 *    mainnet are different agents with separate reputations. A global unique
 *    on `chain_agent_id` would make the second network fail to index at
 *    agent #1. See docs/08 §8.
 */

/** Token amounts and uint256 chain ids. Integer base units as strings. */
const baseUnits = (name: string) => numeric(name, {precision: 38, scale: 0});
const chainUint = (name: string) => numeric(name, {precision: 78, scale: 0});

export const jobState = pgEnum('job_state', [
  'created',
  'accepted',
  'submitted',
  'disputed',
  'settled',
  'refunded',
]);

export const jobPath = pgEnum('job_path', ['escrow', 'direct']);

export const outcome = pgEnum('outcome', ['success', 'failed', 'dispute_lost']);

// ─────────────────────────── identity ───────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: bigint('chain_id', {mode: 'number'}).notNull(),
    /** ERC-8004 ERC-721 token id. NULL until the indexer sees Registered. */
    chainAgentId: chainUint('chain_agent_id'),
    ownerAddress: text('owner_address').notNull(),
    /** The AgentAccount. Per-chain unique, never globally unique. */
    walletAddress: text('wallet_address').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    endpointUrl: text('endpoint_url'),
    pricePerTask: baseUnits('price_per_task').notNull(),
    stake: baseUnits('stake').notNull().default('0'),
    metadataUri: text('metadata_uri'),
    active: boolean('active').notNull().default(true),
    registeredAt: timestamp('registered_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agents_chain_agent_uk').on(t.chainId, t.chainAgentId),
    uniqueIndex('agents_chain_wallet_uk').on(t.chainId, t.walletAddress),
    // Discovery is ALWAYS chain-scoped, or the marketplace silently mixes
    // networks and a testnet agent appears next to a mainnet one.
    index('agents_discovery_idx').on(t.chainId, t.active, t.pricePerTask),
    // Target of the composite FK that makes a cross-chain job impossible.
    uniqueIndex('agents_id_chain_uk').on(t.id, t.chainId),
  ],
);

export const agentCapabilities = pgTable(
  'agent_capabilities',
  {
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    /** Lowercase kebab-case, enforced by @agentx/shared before insert. */
    capability: text('capability').notNull(),
  },
  (t) => [
    primaryKey({columns: [t.agentId, t.capability]}),
    index('agent_capabilities_capability_idx').on(t.capability),
  ],
);

// ─────────────────── reputation (projection of ERC-8004) ───────────────────

/**
 * Derived from indexed `NewFeedback` events, NOT from a live `getSummary()`
 * call. That function loops over every feedback entry per client, and AGENTX
 * is a single client address, so an agent with 1,284 settled jobs means a
 * 1,284-iteration loop in one eth_call. It will hit RPC gas caps.
 */
export const agentStats = pgTable('agent_stats', {
  agentId: bigint('agent_id', {mode: 'number'})
    .primaryKey()
    .references(() => agents.id, {onDelete: 'cascade'}),
  completed: bigint('completed', {mode: 'number'}).notNull().default(0),
  failed: bigint('failed', {mode: 'number'}).notNull().default(0),
  disputed: bigint('disputed', {mode: 'number'}).notNull().default(0),
  volume: baseUnits('volume').notNull().default('0'),
  /** Mirrors the smoothed, volume-damped formula in docs/04 §2.3. */
  score: smallint('score').notNull().default(50),
  lastActiveAt: timestamp('last_active_at', {withTimezone: true}),
});

// ─────────────────────────── jobs ───────────────────────────

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: bigint('chain_id', {mode: 'number'}).notNull(),
    chainJobId: chainUint('chain_job_id'),
    clientAgentId: bigint('client_agent_id', {mode: 'number'}).notNull(),
    workerAgentId: bigint('worker_agent_id', {mode: 'number'}).notNull(),
    path: jobPath('path').notNull(),
    state: jobState('state').notNull().default('created'),
    amount: baseUnits('amount').notNull(),
    fee: baseUnits('fee'),
    spec: jsonb('spec').notNull(),
    specHash: text('spec_hash').notNull(),
    result: jsonb('result'),
    resultHash: text('result_hash'),
    resultUri: text('result_uri'),
    acceptDeadline: timestamp('accept_deadline', {withTimezone: true}),
    workDeadline: timestamp('work_deadline', {withTimezone: true}),
    reviewDeadline: timestamp('review_deadline', {withTimezone: true}),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
    settledAt: timestamp('settled_at', {withTimezone: true}),
    /** Links the row to the agent's OpenTelemetry trace. */
    traceId: text('trace_id'),
  },
  (t) => [
    uniqueIndex('jobs_chain_job_uk').on(t.chainId, t.chainJobId),
    index('jobs_worker_idx').on(t.chainId, t.workerAgentId, t.state),
    index('jobs_client_idx').on(t.chainId, t.clientAgentId, t.createdAt),
    index('jobs_open_idx').on(t.chainId, t.state),
  ],
);

/**
 * Append-only audit log. Never updated, never deleted.
 *
 * `UNIQUE (chain_id, tx_hash, log_index)` is what makes the indexer safely
 * re-runnable: replaying a block range becomes a no-op rather than a
 * duplication. Off-chain events carry a NULL tx_hash, and Postgres treats
 * NULLs as distinct, so they are unaffected.
 */
export const jobEvents = pgTable(
  'job_events',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: bigint('chain_id', {mode: 'number'}).notNull(),
    jobId: bigint('job_id', {mode: 'number'})
      .notNull()
      .references(() => jobs.id, {onDelete: 'cascade'}),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    txHash: text('tx_hash'),
    blockNumber: bigint('block_number', {mode: 'number'}),
    logIndex: integer('log_index'),
    occurredAt: timestamp('occurred_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_events_idempotency_uk').on(t.chainId, t.txHash, t.logIndex),
    index('job_events_job_idx').on(t.jobId, t.id),
  ],
);

// ─────────────────────────── money ───────────────────────────

export const payments = pgTable(
  'payments',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: bigint('chain_id', {mode: 'number'}).notNull(),
    jobId: bigint('job_id', {mode: 'number'}).references(() => jobs.id),
    fromAgentId: bigint('from_agent_id', {mode: 'number'}).references(() => agents.id),
    toAgentId: bigint('to_agent_id', {mode: 'number'}).references(() => agents.id),
    amount: baseUnits('amount').notNull(),
    fee: baseUnits('fee').notNull().default('0'),
    txHash: text('tx_hash').notNull(),
    blockNumber: bigint('block_number', {mode: 'number'}).notNull(),
    confirmedAt: timestamp('confirmed_at', {withTimezone: true}),
  },
  (t) => [uniqueIndex('payments_uk').on(t.chainId, t.txHash, t.jobId)],
);

export const spendPolicies = pgTable('spend_policies', {
  agentId: bigint('agent_id', {mode: 'number'})
    .primaryKey()
    .references(() => agents.id, {onDelete: 'cascade'}),
  perTaskCap: baseUnits('per_task_cap').notNull(),
  dailyCap: baseUnits('daily_cap').notNull(),
  /** A cache for fast rejection. AgentAccount.spentToday is the authority. */
  spentToday: baseUnits('spent_today').notNull().default('0'),
  dayStart: timestamp('day_start', {withTimezone: true}).notNull().defaultNow(),
  allowlistOnly: boolean('allowlist_only').notNull().default(false),
});

/**
 * Nonce ledger and replay guard for the signer.
 *
 * Agents retry, and a retried hire must not create a second job — so the
 * idempotency key is unique, and (agent_id, nonce) cannot collide.
 */
export const signerTxs = pgTable(
  'signer_txs',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    chainId: bigint('chain_id', {mode: 'number'}).notNull(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id),
    idempotencyKey: text('idempotency_key').notNull(),
    nonce: bigint('nonce', {mode: 'number'}).notNull(),
    txHash: text('tx_hash'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('signer_idempotency_uk').on(t.idempotencyKey),
    uniqueIndex('signer_nonce_uk').on(t.chainId, t.agentId, t.nonce),
  ],
);

// ─────────────────────────── disputes & auth ───────────────────────────

export const disputes = pgTable('disputes', {
  jobId: bigint('job_id', {mode: 'number'})
    .primaryKey()
    .references(() => jobs.id),
  raisedBy: bigint('raised_by', {mode: 'number'})
    .notNull()
    .references(() => agents.id),
  reason: text('reason').notNull(),
  reasonHash: text('reason_hash').notNull(),
  resolvedFor: text('resolved_for'),
  resolvedAt: timestamp('resolved_at', {withTimezone: true}),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: bigserial('id', {mode: 'number'}).primaryKey(),
    agentId: bigint('agent_id', {mode: 'number'})
      .notNull()
      .references(() => agents.id, {onDelete: 'cascade'}),
    /** argon2id hash. The key itself is shown once and never stored. */
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    lastUsedAt: timestamp('last_used_at', {withTimezone: true}),
    revokedAt: timestamp('revoked_at', {withTimezone: true}),
  },
  (t) => [uniqueIndex('api_keys_hash_uk').on(t.keyHash)],
);

// ─────────────────────────── indexer ───────────────────────────

/**
 * One cursor per (chain, contract). `last_block_hash` is how a reorg is
 * detected: if the hash at `last_block` no longer matches, roll back and
 * replay — which the job_events unique constraint makes idempotent.
 */
export const indexerCursor = pgTable(
  'indexer_cursor',
  {
    chainId: bigint('chain_id', {mode: 'number'}).notNull(),
    contract: text('contract').notNull(),
    lastBlock: bigint('last_block', {mode: 'number'}).notNull(),
    lastBlockHash: text('last_block_hash').notNull(),
    updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  },
  (t) => [primaryKey({columns: [t.chainId, t.contract]})],
);
