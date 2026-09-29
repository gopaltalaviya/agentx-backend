import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {AgentxError, ErrorCode, type JobSpec} from '@agentx/shared';
import type {AgentxClient, JobSummary} from '@agentx/sdk';
import {
  UNTRUSTED_OPEN,
  Worker,
  confidence,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
  type WorkerEvent,
} from '../src/index.js';

/**
 * The worker loop.
 *
 * The behaviour worth testing here is not "can it call an API" — it is the
 * economics. Reputation is settlement-backed, so an accepted-and-failed job is
 * recorded forever, and a worker that accepts everything ranks below one that
 * accepts selectively. These assert that the worker actually declines, that it
 * declines for a structural reason no prompt can argue with, and that it never
 * delivers a result it has already found wanting.
 */

/**
 * `sources` is OPTIONAL on purpose. The worker CAN produce it, so a client
 * requiring it passes triage — and if the model then omits it, only the
 * self-check stands between that and a delivered result the client must pay
 * to read. That gap is what the self-check test below exercises.
 */
const Output = z.object({
  summary: z.string(),
  confidence: z.number(),
  sources: z.array(z.string()).optional(),
});

class FakeBrain implements Brain {
  readonly name = 'fake';
  readonly prompts: string[] = [];

  constructor(
    private readonly replies: {triage?: unknown; result?: unknown} = {},
    private readonly failOn?: 'triage' | 'result',
  ) {}

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    this.prompts.push(req.prompt);
    const which = req.schemaName === 'TriageDecision' ? 'triage' : 'result';
    if (this.failOn === which) throw new Error(`${which} unavailable`);

    const reply =
      which === 'triage'
        ? (this.replies.triage ?? {accept: true, reason: 'within my capability'})
        : (this.replies.result ?? {summary: 'ETH/USDC depth is healthy', confidence: 0.8});

    return {value: req.schema.parse(reply), provider: 'fake', model: 'fake', cached: false};
  }
  async available() {
    return true;
  }
}

interface Calls {
  accepted: string[];
  submitted: {jobId: string; output: Record<string, unknown>}[];
}

function fakeClient(
  offers: JobSummary[],
  calls: Calls,
  over: {acceptThrows?: unknown} = {},
): AgentxClient {
  return {
    listJobs: async () => offers,
    accept: async (jobId: string) => {
      if (over.acceptThrows) throw over.acceptThrows;
      calls.accepted.push(jobId);
      return {jobId, chainId: 10143, state: 'accepted', txHash: '0x', explorerUrl: 'u'};
    },
    submitResult: async (jobId: string, result: {output: Record<string, unknown>}) => {
      calls.submitted.push({jobId, output: result.output});
      return {jobId, chainId: 10143, state: 'submitted', txHash: '0x', explorerUrl: 'u'};
    },
  } as unknown as AgentxClient;
}

function offer(over: Partial<JobSpec> = {}, jobId = '1'): JobSummary {
  return {
    jobId,
    chainJobId: jobId,
    chainId: 10143,
    state: 'created',
    path: 'escrow',
    amount: '20000',
    amountDisplay: '0.02 USDC',
    spec: {
      capability: 'market-research',
      input: {question: 'how deep is ETH/USDC?'},
      deadlineSeconds: 120,
      ...over,
    } as JobSpec,
    specHash: '0x',
    role: 'worker',
    hasResult: false,
    clientAgentId: '1',
    workerAgentId: '2',
    createdAt: new Date().toISOString(),
  };
}

function build(
  offers: JobSummary[],
  brain: Brain,
  over: {acceptThrows?: unknown} = {},
): {worker: Worker<z.infer<typeof Output>>; calls: Calls; events: WorkerEvent[]} {
  const calls: Calls = {accepted: [], submitted: []};
  const events: WorkerEvent[] = [];
  const worker = new Worker({
    client: fakeClient(offers, calls, over),
    brain,
    capability: 'market-research',
    role: 'a market research agent that reports order book depth',
    output: Output,
    log: (e) => events.push(e),
  });
  return {worker, calls, events};
}

describe('declining, which is the reputation strategy', () => {
  /**
   * Structural and non-negotiable: the client requires a field this worker
   * does not produce. Accepting would guarantee a dispute.
   */
  it('declines a job asking for output it cannot produce, before any model runs', async () => {
    const brain = new FakeBrain();
    const {worker, calls, events} = build(
      [offer({outputSchema: {type: 'object', required: ['summary', 'chart', 'appendix']}})],
      brain,
    );

    const [outcome] = await worker.tick();

    expect(outcome).toMatchObject({status: 'declined'});
    expect(calls.accepted).toEqual([]);
    // The decisive part: no tokens were spent deciding this.
    expect(brain.prompts).toEqual([]);
    expect(events.find((e) => e.kind === 'declined')).toMatchObject({structural: true});
  });

  it('names the fields it cannot produce, so the client can retarget', async () => {
    const {worker} = build(
      [offer({outputSchema: {type: 'object', required: ['summary', 'chart']}})],
      new FakeBrain(),
    );
    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined', reason: expect.stringContaining('chart')});
  });

  /**
   * An optional field the worker CAN produce is not grounds to decline — the
   * conservative reading would have it refusing work it is able to do.
   */
  it('does not decline over a field it can produce but does not always fill', async () => {
    const brain = new FakeBrain({
      result: {summary: 'depth is healthy', confidence: 0.8, sources: ['binance']},
    });
    const {worker, calls} = build(
      [offer({outputSchema: {type: 'object', required: ['sources']}})],
      brain,
    );

    expect(await worker.tick()).toEqual([{status: 'delivered', jobId: '1'}]);
    expect(calls.submitted).toHaveLength(1);
  });

  it('accepts when it can produce everything required', async () => {
    const {worker, calls} = build(
      [offer({outputSchema: {type: 'object', required: ['summary']}})],
      new FakeBrain(),
    );
    const [outcome] = await worker.tick();

    expect(outcome).toMatchObject({status: 'delivered'});
    expect(calls.accepted).toEqual(['1']);
  });

  it('declines on judgement when the input is not workable', async () => {
    const brain = new FakeBrain({triage: {accept: false, reason: 'no market named in the input'}});
    const {worker, calls} = build([offer()], brain);

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined', reason: 'no market named in the input'});
    expect(calls.accepted).toEqual([]);
  });

  /**
   * Fail closed. A worker that accepts work it could not even evaluate has
   * bet its reputation on a coin flip.
   */
  it('declines when triage itself fails', async () => {
    const {worker, calls} = build([offer()], new FakeBrain({}, 'triage'));

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'declined'});
    expect(calls.accepted).toEqual([]);
  });
});

describe('delivering', () => {
  it('submits a result that satisfies the client schema', async () => {
    const {worker, calls} = build([offer()], new FakeBrain());
    await worker.tick();

    expect(calls.submitted).toHaveLength(1);
    expect(calls.submitted[0]!.output).toMatchObject({summary: expect.any(String)});
  });

  /**
   * The check that stops a worker being paid for something it already knows
   * is wrong — and stops the client having to read it to find out.
   */
  it('refuses to submit output that fails the client schema', async () => {
    // The worker can produce `sources`, so triage lets this through — and
    // then the model omits it.
    const brain = new FakeBrain({result: {summary: 'ok', confidence: 0.5}});
    const {worker, calls} = build(
      [offer({outputSchema: {type: 'object', required: ['summary', 'sources']}})],
      brain,
    );

    const [outcome] = await worker.tick();

    expect(outcome).toMatchObject({status: 'failed', stage: 'self-check'});
    expect(calls.submitted).toEqual([]);
  });

  it('submits nothing when the work itself fails', async () => {
    const {worker, calls, events} = build([offer()], new FakeBrain({}, 'result'));

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'failed', stage: 'produce'});
    expect(calls.submitted).toEqual([]);
    // Accepted and then failed: the score takes the hit, which is correct.
    expect(calls.accepted).toEqual(['1']);
    expect(events.some((e) => e.kind === 'failed')).toBe(true);
  });

  /**
   * Losing the race to accept — the job expired, or the client cancelled — is
   * ordinary, not a fault of this worker, and it must not lead to work being
   * done for a job nobody is holding money for.
   */
  it('stops at the accept stage when the job is already gone', async () => {
    const brain = new FakeBrain();
    const {worker, calls} = build([offer()], brain, {
      acceptThrows: new AgentxError(ErrorCode.INVALID_STATE, 'job is no longer created'),
    });

    const [outcome] = await worker.tick();
    expect(outcome).toMatchObject({status: 'failed', stage: 'accept'});
    expect(calls.submitted).toEqual([]);
    // Triage ran; producing did not.
    expect(brain.prompts).toHaveLength(1);
  });
});

describe('confidence', () => {
  /**
   * The first live run had a worker produce a good report with
   * `confidence: 95`, fail its own schema, and deliver nothing — so the
   * client had paid and received a refund instead of a result.
   */
  it('reads a percentage as the fraction it obviously is', () => {
    expect(confidence().parse(95)).toBe(0.95);
    expect(confidence().parse(100)).toBe(1);
  });

  it('leaves a fraction alone', () => {
    expect(confidence().parse(0.8)).toBe(0.8);
    expect(confidence().parse(1)).toBe(1);
    expect(confidence().parse(0)).toBe(0);
  });

  it('still refuses something that is not a confidence at all', () => {
    expect(confidence().safeParse(-1).success).toBe(false);
    expect(confidence().safeParse(101).success).toBe(false);
    expect(confidence().safeParse('high').success).toBe(false);
  });
});

describe('the fast path', () => {
  /**
   * A direct-pay job is settled on chain the moment it is created, but the
   * API writes `state: created` optimistically until the indexer catches up.
   * Deciding from state therefore called accept() on an already-terminal job,
   * the contract reverted, and handle() returned WITHOUT emitting anything —
   * so the failure was invisible and the job was retried on every poll,
   * forever. `path` is set at creation and does not lie.
   */
  it('does not try to accept a job that was already paid', async () => {
    const {worker, calls} = build([{...offer(), path: 'direct'}], new FakeBrain());

    const [outcome] = await worker.tick();
    expect(calls.accepted, 'a fast-path job must not be accepted').toEqual([]);
    expect(outcome).toMatchObject({status: 'delivered'});
    expect(calls.submitted).toHaveLength(1);
  });

  it('still accepts an escrow job', async () => {
    const {worker, calls} = build([{...offer(), path: 'escrow'}], new FakeBrain());
    await worker.tick();
    expect(calls.accepted).toEqual(['1']);
  });

  /** A failure to accept must be visible, and must not be retried forever. */
  it('reports a failed accept and gives up on that job', async () => {
    const {worker, calls, events} = build([{...offer(), path: 'escrow'}], new FakeBrain(), {
      acceptThrows: new AgentxError(ErrorCode.INVALID_STATE, 'job is no longer created'),
    });

    await worker.tick();
    expect(events.some((e) => e.kind === 'failed'), 'the failure must be logged').toBe(true);

    // A second poll must not re-offer it.
    const second = await worker.tick();
    expect(second).toEqual([]);
    expect(calls.submitted).toEqual([]);
  });
});

describe('what the worker shows a model', () => {
  /**
   * A job spec is written by another agent. A "task" instructing the worker to
   * ignore its own rules is an injection wearing a different label, so the
   * spec is wrapped exactly like a result is.
   */
  it('wraps the job spec as untrusted in both the triage and the work prompt', async () => {
    const brain = new FakeBrain();
    const {worker} = build([offer()], brain);
    await worker.tick();

    expect(brain.prompts).toHaveLength(2);
    for (const prompt of brain.prompts) expect(prompt).toContain(UNTRUSTED_OPEN);
  });
});

describe('the offer loop', () => {
  it('ignores offers for a capability it does not provide', async () => {
    const brain = new FakeBrain();
    const {worker, calls} = build([offer({capability: 'trade-execution'})], brain);

    expect(await worker.tick()).toEqual([]);
    expect(calls.accepted).toEqual([]);
    expect(brain.prompts).toEqual([]);
  });

  it('works through every matching offer in one pass', async () => {
    const {worker, calls} = build([offer({}, '1'), offer({}, '2')], new FakeBrain());

    expect(await worker.tick()).toHaveLength(2);
    expect(calls.submitted.map((s) => s.jobId)).toEqual(['1', '2']);
  });
});
