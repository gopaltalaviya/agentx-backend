import {z} from 'zod';
import {AgentxError, ErrorCode, type JobSpec} from '@agentx/shared';
import type {AgentSummary, AgentxClient} from '@agentx/sdk';
import type {Brain} from './brain.js';
import {Judge, validateShape, type Verdict} from './judge.js';
import {PLANNER_SYSTEM, SELECTOR_SYSTEM, SYNTHESIS_SYSTEM, wrapUntrusted} from './prompts.js';

/**
 * The client side: turn one sentence into work other agents get paid for.
 *
 * plan → discover → select → hire → await → validate → judge → settle.
 *
 * ## Every branch is a real branch
 *
 * A demo fails on the paths nobody implemented: no candidate offers the
 * capability, the budget runs out mid-run, a worker accepts and goes quiet,
 * the result comes back the wrong shape. Each of those is handled here and
 * reported as an outcome, because an orchestrator that visibly recovers is
 * more convincing than one that never stumbles — and on stage it is the only
 * kind that finishes.
 *
 * ## Planning never sees a result
 *
 * The planner is called once, before any work comes back. Selection sees only
 * protocol facts — id, price, score — never an agent's own prose. Only the
 * judge and the synthesiser read worker output, and both run with no tools.
 * So an injection in a result cannot reach the call that decides what to
 * commission or what to spend. See docs/10 §1.
 */

export const Plan = z.object({
  subtasks: z
    .array(
      z.object({
        capability: z
          .string()
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          .describe('lowercase kebab-case'),
        input: z.record(z.unknown()).describe('everything the worker needs to start'),
        dependsOn: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('index of an earlier subtask whose result this one needs'),
      }),
    )
    .max(4),
  reasoning: z.string().min(1).max(600),
});
export type Plan = z.infer<typeof Plan>;

export const Selection = z.object({
  agentId: z.number().int().nullable().describe('null if no candidate is worth hiring'),
  reason: z.string().min(1).max(300),
});

export const Synthesis = z.object({
  answer: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
});

export type StepStatus =
  | 'settled'
  | 'disputed'
  /**
   * Judged bad, and nothing can be done about it: a fast-path job whose
   * payment is already final. Distinct from `disputed`, where the money is
   * still recoverable, and from `failed`, which would blame the system for a
   * trade-off the client made deliberately.
   */
  | 'unrecoverable'
  | 'no-candidate'
  | 'budget-exceeded'
  | 'timeout'
  | 'failed';

export interface StepOutcome {
  capability: string;
  status: StepStatus;
  detail: string;
  jobId?: string;
  agentId?: number;
  amount?: string;
  explorerUrl?: string;
  verdict?: Verdict;
  result?: Record<string, unknown>;
}

export interface RunReport {
  goal: string;
  plan: Plan | null;
  steps: StepOutcome[];
  answer: string | null;
  spent: string;
  /** True when at least one subtask settled: partial success is still success. */
  delivered: boolean;
}

export type OrchestratorEvent =
  | {kind: 'planned'; subtasks: number; reasoning: string}
  | {kind: 'discovered'; capability: string; candidates: number}
  | {kind: 'selected'; capability: string; agentId: number; price: string; reason: string}
  | {kind: 'hired'; capability: string; jobId: string; amount: string; explorerUrl: string}
  | {kind: 'judged'; jobId: string; accept: boolean; quality: number; injectionAttempted: boolean}
  | {kind: 'settled'; jobId: string; explorerUrl: string}
  | {kind: 'disputed'; jobId: string; reason: string}
  | {kind: 'skipped'; capability: string; status: StepStatus; detail: string};

export interface OrchestratorOptions {
  client: AgentxClient;
  brain: Brain;
  /** Defaults to the same brain. Separated so judging can use a stronger model. */
  judgeBrain?: Brain;
  log?: (event: OrchestratorEvent) => void;
}

export class Orchestrator {
  private readonly judge: Judge;

  constructor(private readonly opts: OrchestratorOptions) {
    this.judge = new Judge(opts.judgeBrain ?? opts.brain);
  }

  async run(goal: string, opts: {timeoutMs?: number} = {}): Promise<RunReport> {
    const steps: StepOutcome[] = [];
    let spent = 0n;

    // What the marketplace actually sells, before planning what to buy.
    //
    // Without this the planner names capabilities from imagination: the first
    // live run produced data-analysis, position-valuation and trade-advisory,
    // none of which any agent offers, so three of four subtasks died at
    // discovery. Capability strings are protocol data — constrained to
    // kebab-case by a database CHECK — not agent prose, so this adds no
    // injection surface.
    const offered = await this.availableCapabilities();
    const plan = await this.plan(goal, offered).catch(() => null);
    if (!plan || plan.subtasks.length === 0) {
      return {
        goal,
        plan,
        steps,
        answer: null,
        spent: '0',
        delivered: false,
      };
    }
    this.emit({kind: 'planned', subtasks: plan.subtasks.length, reasoning: plan.reasoning});

    // Split what may be spent across the plan up front. Spending it all on
    // subtask one and discovering subtask three is unaffordable is worse than
    // being modest throughout.
    const budget = await this.opts.client.budget();
    const perStep = divide(BigInt(budget.dailyRemaining), plan.subtasks.length);
    const ceiling = minOf(perStep, BigInt(budget.maxSingleSpend));

    for (const [index, subtask] of plan.subtasks.entries()) {
      // A dependency must point BACKWARDS, at a step that has already run.
      //
      // Nothing stopped a planner saying subtask 1 depends on subtask 1. The
      // first live run did exactly that, and since `steps[0]` does not exist
      // while step 0 is being planned, every subtask waited on something that
      // could never have run and the whole plan died without hiring anyone.
      //
      // A self-reference or a forward reference is not a dependency anybody
      // can satisfy, so it is dropped rather than treated as unmet — the
      // subtask simply runs on its own input, which is what the planner
      // evidently meant for the first one.
      const declared = subtask.dependsOn;
      const dependsOn = declared !== undefined && declared < index ? declared : undefined;

      const upstream = dependsOn !== undefined ? steps[dependsOn] : undefined;
      if (dependsOn !== undefined && upstream?.status !== 'settled') {
        steps.push({
          capability: subtask.capability,
          status: 'failed',
          detail: `needed the result of step ${dependsOn + 1}, which ${upstream?.status ?? 'did not run'}`,
        });
        this.emit({
          kind: 'skipped',
          capability: subtask.capability,
          status: 'failed',
          detail: 'upstream step did not deliver',
        });
        continue;
      }

      const outcome = await this.runStep(
        {
          capability: subtask.capability,
          input: {
            // The goal, verbatim, on every job.
            //
            // A planner reasonably emits an empty `input` for the first
            // subtask, because the goal IS the input — and the first live
            // runs did exactly that. The orchestrator then hired a worker,
            // paid it, and asked it to do a job without saying what the job
            // was. The worker declined, correctly, and nothing ever
            // completed. Reading the recording is what showed this: three of
            // four triage decisions were accept, and the one refusal was the
            // job whose input was `{}`.
            //
            // This comes from the user rather than from an agent, so it adds
            // no injection surface — and the worker wraps the whole spec as
            // untrusted regardless.
            goal,
            step: `${index + 1} of ${plan.subtasks.length}`,
            ...subtask.input,
            // The upstream result travels as input. It is another agent's
            // output, so the worker will wrap it as untrusted in turn.
            ...(upstream?.result ? {previousResult: upstream.result} : {}),
          },
          // No outputSchema from the planner.
          //
          // It used to ask the planner for the field names a subtask must
          // produce, which is a guess about a worker it has not chosen yet
          // and whose schema it cannot see. The first live run had a planner
          // answer ["eth","usdc","monad"] — topic words — so every worker
          // correctly refused work it could not satisfy and nothing was ever
          // hired. The coupling was brittle by construction, not badly
          // prompted: no planner can know what fields an unknown worker
          // emits.
          //
          // The worker's own schema governs delivery, the API enforces any
          // schema a client does state, and the judge assesses whether the
          // result actually answers the task. A client that knows exactly
          // what shape it needs can still say so.
          deadlineSeconds: 120,
        },
        ceiling,
        opts.timeoutMs ?? 120_000,
      );

      steps.push(outcome);
      if (outcome.status === 'settled' && outcome.amount) spent += BigInt(outcome.amount);

      // A cap is not a hiccup: every later step would hit the same wall.
      if (outcome.status === 'budget-exceeded') break;
    }

    const settled = steps.filter((s) => s.status === 'settled');
    const answer = settled.length > 0 ? await this.synthesise(goal, settled) : null;

    return {
      goal,
      plan,
      steps,
      answer,
      spent: spent.toString(),
      delivered: settled.length > 0,
    };
  }

  // ── one subtask ────────────────────────────────────────────────────────

  private async runStep(spec: JobSpec, ceiling: bigint, timeoutMs: number): Promise<StepOutcome> {
    const base = {capability: spec.capability};

    if (ceiling <= 0n) {
      return this.skip({...base, status: 'budget-exceeded', detail: 'no budget remaining'});
    }

    const candidates = await this.opts.client.discover({
      capability: spec.capability as never,
      maxPrice: ceiling.toString(),
      rank: 'balanced',
      limit: 10,
    });
    this.emit({kind: 'discovered', capability: spec.capability, candidates: candidates.length});

    if (candidates.length === 0) {
      return this.skip({
        ...base,
        status: 'no-candidate',
        detail: `no agent offers ${spec.capability} at or below ${ceiling} base units`,
      });
    }

    const chosen = await this.select(spec, candidates);
    if (!chosen) {
      return this.skip({
        ...base,
        status: 'no-candidate',
        detail: 'no candidate was worth hiring at this price',
      });
    }

    let receipt;
    try {
      receipt = await this.opts.client.hire({
        workerAgentId: chosen.agentId,
        spec,
        maxPrice: ceiling.toString(),
      });
    } catch (err) {
      // The cap is enforced on-chain and will not move. Reporting it is the
      // job; retrying it is not.
      if (err instanceof AgentxError && err.code === ErrorCode.BUDGET_EXCEEDED) {
        return this.skip({...base, status: 'budget-exceeded', detail: err.message});
      }
      return this.skip({...base, status: 'failed', detail: message(err)});
    }

    this.emit({
      kind: 'hired',
      capability: spec.capability,
      jobId: receipt.jobId,
      amount: receipt.amountDisplay,
      explorerUrl: receipt.explorerUrl,
    });

    const common = {
      ...base,
      jobId: receipt.jobId,
      agentId: chosen.agentId,
      amount: receipt.amount,
      explorerUrl: receipt.explorerUrl,
    };

    let job;
    try {
      job = await this.opts.client.awaitResult(receipt.jobId, {timeoutMs});
    } catch (err) {
      if (err instanceof AgentxError && err.code === ErrorCode.DEADLINE_PASSED) {
        // Not a lost payment: the on-chain deadline expires into a
        // permissionless refund. Say so, rather than implying money is gone.
        return this.skip({
          ...common,
          status: 'timeout',
          detail: 'the worker did not deliver in time — the job expires on-chain into a refund',
        });
      }
      return this.skip({...common, status: 'failed', detail: message(err)});
    }

    if (!job.result) {
      return this.skip({...common, status: 'failed', detail: `job ended as ${job.state} with no result`});
    }

    // Structural first, deterministic, and it keeps a malformed result out of
    // a model context entirely.
    const shape = validateShape(job.result, spec.outputSchema);
    if (!shape.ok) {
      return this.dispute(common, `result is the wrong shape: ${shape.reason}`);
    }

    const verdict = await this.judge
      .evaluate({capability: spec.capability, task: spec.input, result: job.result})
      .catch(() => null);

    if (!verdict) {
      // Judging failed, not the work. Paying on an unread result would reward
      // a worker for our outage; disputing punishes them for it. The escrow's
      // review window expires in the worker's favour, so doing nothing is the
      // one option that does not make our failure their problem.
      return this.skip({
        ...common,
        status: 'failed',
        detail: 'could not evaluate the result; left for the review window to settle',
        result: job.result,
      });
    }

    this.emit({
      kind: 'judged',
      jobId: receipt.jobId,
      accept: verdict.accept,
      quality: verdict.quality,
      injectionAttempted: verdict.injectionAttempted,
    });

    if (!verdict.accept) {
      // The fast path has no recourse, and saying so is the honest report.
      //
      // A direct-pay job transferred the money when it was created; the
      // contract is finished with it and refuses a dispute. Calling one
      // anyway produced `INVALID_STATE: job is "settled", this action needs
      // "submitted"` and a step reported as `failed`, which reads as a broken
      // system rather than as the limit of a path the client chose in
      // exchange for skipping escrow.
      //
      // The result is kept. The money is spent either way, and a downstream
      // step is better served by disappointing work plus a warning than by
      // nothing at all.
      if (job.path === 'direct') {
        return this.skip({
          ...common,
          verdict,
          status: 'unrecoverable',
          detail:
            `${verdict.reason} — paid up front on the fast path, so there is no dispute to raise; ` +
            'the cost of skipping escrow is that a bad result cannot be reversed',
          result: job.result,
        });
      }
      return this.dispute({...common, verdict}, verdict.reason);
    }

    // The fast path already settled on hire; approving it would revert.
    if (job.state !== 'settled') {
      try {
        const settled = await this.opts.client.approve(receipt.jobId);
        this.emit({kind: 'settled', jobId: receipt.jobId, explorerUrl: settled.explorerUrl});
      } catch (err) {
        return this.skip({...common, status: 'failed', detail: `approve failed: ${message(err)}`});
      }
    } else {
      this.emit({kind: 'settled', jobId: receipt.jobId, explorerUrl: receipt.explorerUrl});
    }

    return {...common, status: 'settled', detail: verdict.reason, verdict, result: job.result};
  }

  // ── model calls ────────────────────────────────────────────────────────

  /** The distinct capabilities on offer right now, from discovery. */
  private async availableCapabilities(): Promise<string[]> {
    const agents = await this.opts.client.discover({limit: 50}).catch(() => []);
    return [...new Set(agents.flatMap((a) => a.capabilities))].sort();
  }

  private async plan(goal: string, offered: string[]): Promise<Plan> {
    const menu =
      offered.length === 0
        ? ''
        : [
            '',
            '',
            'The ONLY capabilities any agent offers are:',
            ...offered.map((c) => `  - ${c}`),
            '',
            'Use these exact strings. A capability outside this list matches no',
            'agent, so that subtask buys nothing and wastes the budget. If the',
            'goal cannot be served by these, return an empty list and say why.',
          ].join('\n');

    const {value} = await this.opts.brain.complete({
      schema: Plan,
      schemaName: 'Plan',
      system: PLANNER_SYSTEM,
      // The goal comes from the user, not from another agent, so it is not
      // wrapped. Everything an agent produced is.
      prompt: `The goal:\n${goal}${menu}\n\nPlan the work.`,
      maxTokens: 1_500,
      effort: 'medium',
    });
    return value;
  }

  /**
   * Choose between candidates.
   *
   * Candidates are protocol facts — id, price, score, completions — and never
   * an agent's own prose, so there is no injection surface in this call.
   */
  private async select(spec: JobSpec, candidates: AgentSummary[]): Promise<AgentSummary | null> {
    const facts = candidates.map((c) => ({
      agentId: c.agentId,
      price: c.pricePerTask,
      priceDisplay: c.priceDisplay,
      score: c.score,
      completed: c.completed,
      failed: c.failed,
      capabilities: c.capabilities,
    }));

    const {value} = await this.opts.brain.complete({
      schema: Selection,
      schemaName: 'Selection',
      system: SELECTOR_SYSTEM,
      prompt: [
        `Subtask capability: ${spec.capability}`,
        '',
        'Candidates:',
        JSON.stringify(facts, null, 2),
        '',
        'Which one, if any?',
      ].join('\n'),
      maxTokens: 500,
      effort: 'low',
    });

    // A hallucinated id must not become a hire. Only an id that was actually
    // offered counts.
    const chosen = candidates.find((c) => c.agentId === value.agentId) ?? null;
    if (chosen) {
      // The reason is emitted, not just the id: "why this agent" is the
      // question an audience asks, and a marketplace that cannot answer it
      // looks like a lottery.
      this.emit({
        kind: 'selected',
        capability: spec.capability,
        agentId: chosen.agentId,
        price: chosen.priceDisplay,
        reason: value.reason,
      });
    }
    return chosen;
  }

  private async synthesise(goal: string, settled: StepOutcome[]): Promise<string | null> {
    const {value} = await this.opts.brain
      .complete({
        schema: Synthesis,
        schemaName: 'Synthesis',
        system: SYNTHESIS_SYSTEM,
        prompt: [
          `The goal:\n${goal}`,
          '',
          'What the agents you hired returned:',
          // Every one of these is third-party output.
          ...settled.map((s) => `\n${s.capability}:\n${wrapUntrusted(s.result)}`),
          '',
          'Answer the goal.',
        ].join('\n'),
        maxTokens: 2_000,
        effort: 'medium',
      })
      .catch(() => ({value: null}));

    return value?.answer ?? null;
  }

  // ── outcomes ───────────────────────────────────────────────────────────

  private async dispute(
    common: Omit<StepOutcome, 'status' | 'detail'>,
    reason: string,
  ): Promise<StepOutcome> {
    try {
      await this.opts.client.dispute(common.jobId!, reason);
      this.emit({kind: 'disputed', jobId: common.jobId!, reason});
    } catch (err) {
      return {...common, status: 'failed', detail: `dispute failed: ${message(err)}`};
    }
    return {...common, status: 'disputed', detail: reason};
  }

  private skip(outcome: StepOutcome): StepOutcome {
    this.emit({
      kind: 'skipped',
      capability: outcome.capability,
      status: outcome.status,
      detail: outcome.detail,
    });
    return outcome;
  }

  private emit(event: OrchestratorEvent): void {
    this.opts.log?.(event);
  }
}

/** Integer division that never returns a negative share. */
function divide(total: bigint, parts: number): bigint {
  if (parts <= 0 || total <= 0n) return 0n;
  return total / BigInt(parts);
}

const minOf = (a: bigint, b: bigint) => (a < b ? a : b);

function message(err: unknown): string {
  if (err instanceof AgentxError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
