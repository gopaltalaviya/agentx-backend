import type {ZodType} from 'zod';

/**
 * A `Brain` turns a prompt into a schema-valid object. That is the whole
 * contract.
 *
 * Every provider is reduced to this, which is what makes them
 * interchangeable. The interface deliberately does NOT expose messages,
 * tools, streaming or provider options: an AGENTX worker only ever needs
 * "given this task, produce something matching this schema", and a narrow
 * interface is what lets a rate-limited provider be swapped mid-run without
 * any caller knowing.
 *
 * Schema validity is the point. A worker's result is checked against the
 * job's `outputSchema` before it is accepted on-chain, so a result that
 * cannot satisfy its schema is a failed job and a reputation hit. Making the
 * model produce valid output *by construction* is cheaper than disputing it
 * afterwards.
 */
export interface Brain {
  /** Stable identifier, recorded on every result so a run is explainable. */
  readonly name: string;

  complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>>;

  /** Cheap liveness probe used by the fallback chain. */
  available(): Promise<boolean>;
}

export interface CompletionRequest<T> {
  /** The shape the answer must take. */
  schema: ZodType<T>;
  /** A name for the schema — used as part of the cache key. */
  schemaName: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  /** Hint only. Providers that cannot express it ignore it. */
  effort?: 'low' | 'medium' | 'high';
}

export interface CompletionResult<T> {
  value: T;
  /** Which brain actually produced this, after any fallback. */
  provider: string;
  model: string;
  usage?: {inputTokens?: number; outputTokens?: number};
  /** True when replayed from cache rather than generated. */
  cached: boolean;
}

/**
 * Thrown when a provider is unavailable *for reasons that another provider
 * might not share* — rate limits, outages, timeouts, auth.
 *
 * The distinction matters: a fallback chain should move on from "I am rate
 * limited", but NOT from "the model produced something that fails the
 * schema". The second is a prompt or schema problem, and every provider will
 * reproduce it. Falling through on it would burn the whole chain and hide
 * the real fault.
 */
export class BrainUnavailable extends Error {
  constructor(
    readonly provider: string,
    readonly reason: 'rate_limit' | 'auth' | 'timeout' | 'outage' | 'not_configured',
    message: string,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'BrainUnavailable';
  }
}

/** The model produced output that does not satisfy the schema. Not retryable elsewhere. */
export class BrainInvalidOutput extends Error {
  constructor(
    readonly provider: string,
    readonly issues: string,
  ) {
    super(`${provider} returned output failing its schema: ${issues}`);
    this.name = 'BrainInvalidOutput';
  }
}

/** Stable cache key for a request. Excludes anything that varies per run. */
export async function cacheKey(req: CompletionRequest<unknown>): Promise<string> {
  const {createHash} = await import('node:crypto');
  return createHash('sha256')
    .update([req.schemaName, req.system, req.prompt].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}
