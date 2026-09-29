import {
  AgentxError,
  ErrorCode,
  type BaseUnits,
  type Capability,
  type JobSpec,
  type JobState,
} from '@agentx/shared';

/**
 * @agentx/sdk — the typed client every agent imports.
 *
 * Exists so an agent never hand-rolls `fetch` against the API. Two things it
 * does that a raw fetch would not:
 *
 * 1. **Turns RFC 7807 problems back into `AgentxError`**, so an orchestrator
 *    branches on a stable `code` rather than a status number or a message.
 * 2. **Requires an idempotency key on anything that spends money**, and
 *    generates a deterministic one when the caller does not supply it. Agents
 *    retry; a retried hire must not become a second payment.
 */

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  chainId?: number;
  fetchImpl?: typeof fetch;
  /** Total attempts for transient failures. Budget errors are never retried. */
  maxRetries?: number;
}

export interface AgentSummary {
  agentId: number;
  chainId: number;
  network: string;
  name: string;
  description: string | null;
  capabilities: string[];
  pricePerTask: BaseUnits;
  priceDisplay: string;
  walletAddress: string;
  score: number;
  completed: number;
  failed: number;
  successRate: number | null;
  active: boolean;
  explorerUrl: string;
}

export interface JobReceipt {
  jobId: string;
  chainJobId: string | null;
  chainId: number;
  network: string;
  state: JobState | 'settled';
  path: 'direct' | 'escrow';
  amount: BaseUnits;
  amountDisplay: string;
  specHash: string;
  txHash: string;
  explorerUrl: string;
}

export interface JobDetail extends Omit<JobReceipt, 'txHash' | 'explorerUrl'> {
  fee: BaseUnits | null;
  spec: JobSpec;
  result: Record<string, unknown> | null;
  resultHash: string | null;
  createdAt: string;
  settledAt: string | null;
  events: {kind: string; txHash: string | null; explorerUrl: string | null; occurredAt: string}[];
}

export interface NetworkInfo {
  chainId: number;
  name: string;
  shortName: string;
  testnet: boolean;
  nativeCurrency: {name: string; symbol: string; decimals: number};
  paymentToken: {symbol: string; decimals: number; address: string | null};
  contracts: Record<string, string>;
  erc8004: Record<string, string>;
  explorerBaseUrl: string | null;
  faucetUrls: string[];
  confirmations: number;
  windows: {accept: number; work: number; review: number};
  fastPathMax: BaseUnits;
  fastPathMaxDisplay: string;
  protocolFeeBps: number;
  enabledChains: number[];
}

export interface Budget {
  agentId: string;
  chainId: number;
  network: string;
  testnet: boolean;
  /** 'chain' is authoritative; 'cache' may be stale. */
  source: 'chain' | 'cache';
  perTaskCap: BaseUnits;
  perTaskCapDisplay: string;
  dailyCap: BaseUnits;
  dailyCapDisplay: string;
  dailyRemaining: BaseUnits;
  dailyRemainingDisplay: string;
  /** The tighter of the two caps: the most one hire can cost right now. */
  maxSingleSpend: BaseUnits;
  maxSingleSpendDisplay: string;
  allowlistOnly: boolean;
  tokenBalance: BaseUnits | null;
  tokenSymbol: string;
  walletAddress: string | null;
  resetsInSeconds: number;
}

/**
 * What a state-changing action returns.
 *
 * Typed rather than `unknown` so a caller can log the explorer URL without
 * casting — the link is the thing that makes an on-chain action believable to
 * whoever is watching.
 */
export interface ActionReceipt {
  jobId: string;
  chainId: number;
  state: JobState | 'settled';
  txHash: string;
  explorerUrl: string;
}

/** A row from `GET /v1/jobs` — enough to decide, not the full detail. */
export interface JobSummary {
  jobId: string;
  chainJobId: string | null;
  chainId: number;
  state: JobState;
  path: 'direct' | 'escrow';
  amount: BaseUnits;
  amountDisplay: string;
  spec: JobSpec;
  specHash: string;
  /** Which side the caller is on. */
  role: 'worker' | 'client';
  /** False when the work still needs doing, whatever the payment state is. */
  hasResult: boolean;
  clientAgentId: string;
  workerAgentId: string;
  createdAt: string;
}

export interface DiscoverQuery {
  capability?: Capability;
  maxPrice?: BaseUnits;
  minScore?: number;
  rank?: 'balanced' | 'quality' | 'cheapest' | 'fastest';
  limit?: number;
}

export class AgentxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly chainId: number | undefined;
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.chainId = opts.chainId;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  // ── discovery ──────────────────────────────────────────────────────────

  /** Browse the marketplace. Needs no credentials. */
  async discover(q: DiscoverQuery = {}): Promise<AgentSummary[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    if (this.chainId) params.set('chainId', String(this.chainId));

    const {agents} = await this.request<{agents: AgentSummary[]}>('GET', `/v1/agents?${params}`, {
      auth: false,
    });
    return agents;
  }

  async getAgent(agentId: number): Promise<AgentSummary> {
    return this.request<AgentSummary>('GET', `/v1/agents/${agentId}`, {auth: false});
  }

  /** Which chain, and whether its money is real. Needs no credentials. */
  async network(): Promise<NetworkInfo> {
    const q = this.chainId ? `?chainId=${this.chainId}` : '';
    return this.request<NetworkInfo>('GET', `/v1/network${q}`, {auth: false});
  }

  /**
   * What this agent may still spend.
   *
   * Call it BEFORE planning a spend, not after a 402. An agent that learns its
   * cap by being refused is an agent that retries into a rate limit.
   */
  async budget(): Promise<Budget> {
    return this.request<Budget>('GET', '/v1/budget', {});
  }

  // ── hiring ─────────────────────────────────────────────────────────────

  /**
   * Hire an agent.
   *
   * @param idempotencyKey Supply your own to make a retry across process
   *   restarts safe. Omitted, one is derived from the request itself, which
   *   covers an in-process retry but not a restart.
   */
  async hire(args: {
    workerAgentId: number;
    spec: JobSpec;
    maxPrice: BaseUnits;
    path?: 'auto' | 'direct' | 'escrow';
    idempotencyKey?: string;
  }): Promise<JobReceipt> {
    const key = args.idempotencyKey ?? (await deriveKey(args.workerAgentId, args.spec));
    return this.request<JobReceipt>('POST', '/v1/jobs', {
      idempotencyKey: key,
      body: {
        workerAgentId: String(args.workerAgentId),
        spec: args.spec,
        maxPrice: args.maxPrice,
        path: args.path ?? 'auto',
      },
    });
  }

  /**
   * The caller's jobs.
   *
   * How a worker learns it was hired. Oldest first, because the job closest to
   * its accept deadline is the one that matters.
   */
  async listJobs(
    q: {role?: 'worker' | 'client'; state?: JobState; limit?: number} = {},
  ): Promise<JobSummary[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    const {jobs} = await this.request<{jobs: JobSummary[]}>('GET', `/v1/jobs?${params}`, {});
    return jobs;
  }

  getJob(jobId: string): Promise<JobDetail> {
    return this.request<JobDetail>('GET', `/v1/jobs/${jobId}`, {auth: false});
  }

  accept(jobId: string): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/accept`, {});
  }

  submitResult(
    jobId: string,
    result: {output: Record<string, unknown>; producedAt?: string},
  ): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/result`, {
      body: {output: result.output, producedAt: result.producedAt ?? new Date().toISOString()},
    });
  }

  approve(jobId: string): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/approve`, {});
  }

  dispute(jobId: string, reason: string): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/dispute`, {body: {reason}});
  }

  cancel(jobId: string): Promise<ActionReceipt> {
    return this.request<ActionReceipt>('POST', `/v1/jobs/${jobId}/cancel`, {});
  }

  /**
   * Block until a job reaches a terminal state.
   *
   * Polls rather than streams: an agent that loses its SSE connection must
   * still make progress, and the job's state is durable either way.
   */
  async awaitResult(
    jobId: string,
    opts: {timeoutMs?: number; pollMs?: number} = {},
  ): Promise<JobDetail> {
    const timeout = opts.timeoutMs ?? 120_000;
    const poll = opts.pollMs ?? 1_500;
    const deadline = Date.now() + timeout;

    for (;;) {
      const job = await this.getJob(jobId);
      if (job.state === 'settled' || job.state === 'refunded') return job;

      if (Date.now() > deadline) {
        // A timeout is not a failure of the protocol: the job still has an
        // on-chain deadline and a permissionless exit. Say which, so the
        // caller can decide between waiting and moving on.
        throw new AgentxError(
          ErrorCode.DEADLINE_PASSED,
          `job ${jobId} was still "${job.state}" after ${timeout}ms — it remains recoverable on-chain via its expiry`,
        );
      }
      await sleep(poll);
    }
  }

  /** Live events for a job. Returns an unsubscribe function. */
  subscribe(jobId: string, onEvent: (event: string, data: unknown) => void): () => void {
    const controller = new AbortController();

    void (async () => {
      try {
        const res = await this.doFetch(`${this.baseUrl}/v1/jobs/${jobId}/events`, {
          headers: {accept: 'text/event-stream'},
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream: true});

          // SSE frames are separated by a blank line; a chunk boundary can
          // land mid-frame, so only whole frames are consumed.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (!event || !data) continue;

            // Per frame, because `JSON.parse` on one bad frame used to throw
            // all the way out of this loop into the catch below — which
            // treats a dropped stream as normal. One malformed frame
            // therefore ended the whole subscription silently: every later
            // event lost, nothing logged, and on the demo page a trace that
            // simply stops mid-run and looks like a crashed backend.
            //
            // A subscriber that throws is contained for the same reason.
            try {
              onEvent(event, JSON.parse(data));
            } catch {
              // Skip this frame and keep reading the stream.
            }
          }
        }
      } catch {
        // An aborted or dropped stream is not fatal — awaitResult still polls.
      }
    })();

    return () => controller.abort();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    opts: {body?: unknown; idempotencyKey?: string; auth?: boolean},
  ): Promise<T> {
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (opts.auth !== false) headers['authorization'] = `Bearer ${this.apiKey}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          ...(opts.body !== undefined ? {body: JSON.stringify(opts.body)} : {}),
        });
      } catch (err) {
        // Network-level failure. Retrying a POST is safe precisely because
        // the idempotency key makes it so.
        lastError = err;
        await sleep(backoff(attempt));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      const problem = (await res.json().catch(() => ({}))) as {
        code?: string;
        detail?: string;
        retryAfter?: number;
      };
      const error = new AgentxError(
        (problem.code as ErrorCode) ?? ErrorCode.INVALID_STATE,
        problem.detail ?? `${method} ${path} failed with ${res.status}`,
        problem.retryAfter,
      );

      // Retry only what can plausibly succeed later. A budget cap, a price
      // above maxPrice or a schema mismatch will not fix itself, and retrying
      // them wastes the agent's time and the operator's rate limit.
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === this.maxRetries - 1) throw error;

      lastError = error;
      await sleep(problem.retryAfter ? problem.retryAfter * 1000 : backoff(attempt));
    }

    throw lastError instanceof Error
      ? lastError
      : new AgentxError(ErrorCode.INVALID_STATE, String(lastError));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, so retries do not synchronise. */
const backoff = (attempt: number) => 2 ** attempt * 250 + Math.random() * 250;

/**
 * A key derived from the request itself.
 *
 * Deliberately excludes the clock: two identical hires a second apart are
 * almost certainly a retry, and treating them as one payment is the safer
 * failure. A caller that genuinely wants two identical jobs passes its own key.
 */
async function deriveKey(workerAgentId: number, spec: JobSpec): Promise<string> {
  const {canonicalize} = await import('@agentx/shared');
  const {keccak256, toHex} = await import('viem');
  return keccak256(toHex(`${workerAgentId}:${canonicalize(spec)}`)).slice(2, 34);
}

export {AgentxError, ErrorCode};
