import {z} from 'zod';
import {AgentxError, ErrorCode, type JobSpec} from '@agentx/shared';
import type {AgentxClient, JobSummary} from '@agentx/sdk';
import type {Brain} from './brain.js';
import {BrainInvalidOutput} from './brain.js';
import {TRIAGE_SYSTEM, WORKER_SYSTEM, wrapUntrusted} from './prompts.js';
import {validateShape} from './judge.js';

/**
 * The worker side of the marketplace.
 *
 * One base class; a worker is then a capability, an output schema and a
 * sentence describing what it does. Everything below — polling for offers,
 * deciding whether to take one, producing a result, checking it before
 * delivering — is the same for every worker, and getting it right once is the
 * point.
 *
 * ## Declining is the strategy
 *
 * Reputation here is settlement-backed: a score only moves when a payment
 * settles on-chain, and a job accepted and failed is recorded as failed
 * forever. So a worker that accepts everything and fails one in five ranks
 * below one that accepts selectively and completes ~all of them.
 *
 * That is the incentive the protocol was built to create, and a worker that
 * did not actually exhibit it would make the whole claim decorative. So this
 * declines for two independent reasons:
 *
 *   1. **Structurally** — the client asked for output fields this worker
 *      cannot produce. Checked against the schema, no model involved, and it
 *      is not overridable.
 *   2. **By judgement** — the input is missing something the task needs.
 *
 * A declined job is simply not accepted. It expires at its on-chain accept
 * deadline and the client is refunded permissionlessly; there is no "decline"
 * transaction to pay for, and silence costs the worker nothing but the offer.
 */

/**
 * A confidence between 0 and 1, accepting the percentage models keep emitting.
 *
 * Asking for 0..1 and rejecting anything else is correct but loses real work:
 * the first live run had a worker produce a perfectly good report with
 * `confidence: 95`, fail its own schema, and deliver nothing — so the client
 * had paid and got a refund instead of a result. A value above 1 and at most
 * 100 is unambiguously a percentage, so it is read as one. Anything else still
 * fails, because it is not a confidence.
 */
export const confidence = () =>
  z.preprocess(
    (v) => (typeof v === 'number' && v > 1 && v <= 100 ? v / 100 : v),
    z.number().min(0).max(1),
  );

export const TriageDecision = z.object({
  accept: z.boolean(),
  reason: z.string().min(1).max(300).describe('which condition failed, or why you can do this'),
});
export type TriageDecision = z.infer<typeof TriageDecision>;

export interface WorkerOptions<T> {
  client: AgentxClient;
  brain: Brain;
  /** The one capability this worker offers, lowercase kebab-case. */
  capability: string;
  /** How the worker describes itself to the model. One or two sentences. */
  role: string;
  /** The shape of a result. Producing to schema is what makes it valid by construction. */
  output: z.ZodType<T>;
  log?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | {kind: 'offer'; jobId: string; capability: string}
  | {kind: 'declined'; jobId: string; reason: string; structural: boolean}
  | {kind: 'accepted'; jobId: string}
  | {kind: 'delivered'; jobId: string; provider: string; latencyMs: number}
  | {kind: 'failed'; jobId: string; stage: string; reason: string};

export type Outcome =
  | {status: 'declined'; reason: string}
  | {status: 'delivered'; jobId: string}
  | {status: 'failed'; stage: string; reason: string};

export class Worker<T> {
  private readonly requiredKeys: Set<string>;

  /**
   * Jobs this worker has already refused.
   *
   * A decline leaves the job in `created`, so without this the very next poll
   * offers it again — and again. The first live run produced eighteen
   * identical refusals of one job in a few seconds, each costing a model call
   * on the judgement path. A decision already taken is not re-taken.
   */
  private readonly declined = new Set<string>();

  constructor(private readonly opts: WorkerOptions<T>) {
    this.requiredKeys = keysOf(opts.output);
  }

  get capability(): string {
    return this.opts.capability;
  }

  /**
   * One pass: take every offered job and resolve it.
   *
   * Sequential on purpose. A worker with one wallet has one nonce, and two
   * accepts racing for it is a stuck transaction at exactly the wrong moment.
   */
  async tick(): Promise<Outcome[]> {
    // Not filtered by state.
    //
    // A fast-path job is `settled` from the instant it is created, because
    // the client has already paid — but the work still has to be done. A
    // worker polling only for `created` never saw those at all, so the client
    // paid and then waited for a result nobody was producing. What decides
    // whether there is work here is `hasResult`, not the payment state.
    const offers = await this.opts.client.listJobs({role: 'worker', limit: 25});
    const outcomes: Outcome[] = [];

    for (const offer of offers) {
      if (offer.spec.capability !== this.opts.capability) continue;
      if (offer.hasResult) continue;
      if (offer.state === 'refunded' || offer.state === 'disputed') continue;
      if (this.declined.has(offer.jobId)) continue;
      outcomes.push(await this.handle(offer));
    }
    return outcomes;
  }

  /** Poll until stopped. `signal` is how a demo shuts a worker down cleanly. */
  async run(opts: {intervalMs?: number; signal?: AbortSignal} = {}): Promise<void> {
    const interval = opts.intervalMs ?? 1_000;

    while (!opts.signal?.aborted) {
      try {
        await this.tick();
      } catch (err) {
        // A worker that dies on a transient API error is a worker that misses
        // every offer after the first blip.
        this.emit({
          kind: 'failed',
          jobId: '-',
          stage: 'poll',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(interval);
    }
  }

  async handle(offer: JobSummary): Promise<Outcome> {
    this.emit({kind: 'offer', jobId: offer.jobId, capability: offer.spec.capability});

    const structural = this.canSatisfy(offer.spec);
    if (!structural.ok) {
      this.declined.add(offer.jobId);
      this.emit({kind: 'declined', jobId: offer.jobId, reason: structural.reason, structural: true});
      return {status: 'declined', reason: structural.reason};
    }

    const decision = await this.triage(offer.spec);
    if (!decision.accept) {
      this.declined.add(offer.jobId);
      this.emit({kind: 'declined', jobId: offer.jobId, reason: decision.reason, structural: false});
      return {status: 'declined', reason: decision.reason};
    }

    try {
      // Decided by PATH, not by state.
      //
      // A fast-path job is paid and terminal on chain the moment it is
      // created, but the API writes `state: created` optimistically until the
      // indexer catches up. Reading state therefore meant calling accept() on
      // an already-settled job: the contract reverted, this method returned
      // without emitting anything, and the job came back on the very next
      // poll — an invisible failure retried forever. `path` is fixed when the
      // job is created and does not lie.
      if (offer.path === 'escrow') await this.opts.client.accept(offer.jobId);
    } catch (err) {
      // Losing the race to accept is ordinary — the job may have expired or
      // been cancelled between the listing and now. It is not this worker's
      // fault, but it must be VISIBLE, and it must not be retried on every
      // poll for the rest of the run.
      this.declined.add(offer.jobId);
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'accept', reason: message(err)});
      return {status: 'failed', stage: 'accept', reason: message(err)};
    }
    if (offer.path === 'escrow') this.emit({kind: 'accepted', jobId: offer.jobId});

    const startedAt = Date.now();
    let output: T;
    let provider: string;

    try {
      const produced = await this.produce(offer.spec);
      output = produced.output;
      provider = produced.provider;
    } catch (err) {
      // Accepted and could not deliver. The job expires at its work deadline,
      // the client is refunded, and this worker's score takes the hit — which
      // is the correct accounting. Nothing is submitted: a result that failed
      // its own schema is worse than no result, because the client would have
      // to read it to find out.
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'produce', reason: message(err)});
      return {status: 'failed', stage: 'produce', reason: message(err)};
    }

    // Check against what the CLIENT asked for, not only our own schema. The
    // two can differ, and the client's is the one the payment depends on.
    const shape = validateShape(output, offer.spec.outputSchema);
    if (!shape.ok) {
      this.emit({kind: 'failed', jobId: offer.jobId, stage: 'self-check', reason: shape.reason});
      return {status: 'failed', stage: 'self-check', reason: shape.reason};
    }

    const latencyMs = Date.now() - startedAt;
    try {
      await this.opts.client.submitResult(offer.jobId, {
        output: output as Record<string, unknown>,
      });
    } catch (err) {
      return {status: 'failed', stage: 'submit', reason: message(err)};
    }

    this.emit({kind: 'delivered', jobId: offer.jobId, provider, latencyMs});
    return {status: 'delivered', jobId: offer.jobId};
  }

  /**
   * Can this worker produce every field the client requires?
   *
   * Structural, deterministic, and checked before any model is asked — a
   * worker that cannot produce `sources` should decline a job that requires
   * `sources`, not accept it and hope. No prompt can talk it out of this.
   */
  canSatisfy(spec: JobSpec): {ok: true} | {ok: false; reason: string} {
    const required = Array.isArray(spec.outputSchema?.['required'])
      ? (spec.outputSchema['required'] as string[])
      : [];

    const missing = required.filter((key) => !this.requiredKeys.has(key));
    return missing.length === 0
      ? {ok: true}
      : {
          ok: false,
          reason: `this agent does not produce ${missing.join(', ')} — declining rather than delivering a result that cannot be accepted`,
        };
  }

  /** Should this job be taken at all? */
  private async triage(spec: JobSpec): Promise<TriageDecision> {
    const required = Array.isArray(spec.outputSchema?.['required'])
      ? (spec.outputSchema['required'] as string[])
      : [];

    const prompt = [
      `You are: ${this.opts.role}`,
      `You offer exactly one capability: ${this.opts.capability}`,
      `You always produce these fields: ${[...this.requiredKeys].join(', ')}`,
      required.length > 0
        ? `This job additionally requires: ${required.join(', ')}`
        : 'This job states no required output shape, so your own schema governs.',
      '',
      'The job offer:',
      // The spec was written by another agent. Wrapped for the same reason a
      // result is: a "task" that tells the worker to ignore its own rules is
      // an injection with a different label.
      wrapUntrusted(spec),
      '',
      'Accept this job?',
    ].join('\n');

    try {
      const {value} = await this.opts.brain.complete({
        schema: TriageDecision,
        schemaName: 'TriageDecision',
        system: TRIAGE_SYSTEM,
        prompt,
        maxTokens: 400,
        effort: 'low',
      });
      return value;
    } catch {
      // If triage cannot run, decline. Accepting work this worker could not
      // even think about is how a reputation is lost.
      return {accept: false, reason: 'could not evaluate the offer'};
    }
  }

  /** Do the work, to schema. */
  private async produce(spec: JobSpec): Promise<{output: T; provider: string}> {
    const prompt = [
      `You are: ${this.opts.role}`,
      '',
      'The task:',
      wrapUntrusted(spec.input),
      '',
      'Produce the result.',
    ].join('\n');

    const {value, provider} = await this.opts.brain.complete({
      schema: this.opts.output,
      schemaName: 'Result',
      system: WORKER_SYSTEM,
      prompt,
      maxTokens: 2_000,
      effort: 'low',
    });

    return {output: value, provider};
  }

  private emit(event: WorkerEvent): void {
    this.opts.log?.(event);
  }
}

/** The top-level field names a schema produces. */
function keysOf(schema: z.ZodType): Set<string> {
  const unwrapped = schema instanceof z.ZodEffects ? schema.innerType() : schema;
  return unwrapped instanceof z.ZodObject
    ? new Set(Object.keys(unwrapped.shape as Record<string, unknown>))
    : new Set<string>();
}

function message(err: unknown): string {
  if (err instanceof AgentxError) return `${err.code}: ${err.detail ?? ''}`.trim();
  if (err instanceof BrainInvalidOutput) return `invalid model output: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export {ErrorCode};
