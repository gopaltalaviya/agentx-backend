import {eq} from 'drizzle-orm';
import {runEvents, runs, type Db} from '@agentx/db';
import type {EventBus} from './events.js';

/**
 * Executing an orchestrator run, and recording it as it happens.
 *
 * ## Why this lives in the API process
 *
 * A run is a long-lived agent loop, and long-lived work inside an HTTP
 * service is normally the wrong shape. It is here because the live demo page
 * needs one stream of one run, and a separate runner service would add a
 * queue, a second deployment and a failure mode between the page and the
 * thing it is showing — three ways for the demo to break, to avoid a scaling
 * problem a hackathon demo does not have.
 *
 * The seam is kept explicit so that stays a choice: `RunExecutor` is injected,
 * and moving runs to their own service means supplying a different one.
 *
 * ## Why every event is written before it is published
 *
 * The page may connect late, refresh, or be opened again after the run is
 * over — and the finished run is the artefact worth keeping. So the row is
 * the record and the stream is a convenience, never the other way round.
 */

export interface RunEvent {
  kind: string;
  [key: string]: unknown;
}

export interface RunContext {
  runId: number;
  agentId: number;
  apiKey: string;
  goal: string;
  emit: (event: RunEvent) => Promise<void>;
}

export interface RunResult {
  answer: string | null;
  spent: string;
  steps: unknown[];
  delivered: boolean;
}

/** What actually performs a run. Injected so the API can be tested without a model. */
export type RunExecutor = (ctx: RunContext) => Promise<RunResult>;

export class RunService {
  constructor(
    private readonly deps: {
      db: Db;
      bus: EventBus;
      execute: RunExecutor;
      log?: (err: unknown, msg: string) => void;
    },
  ) {}

  /**
   * Start a run and return immediately with its id.
   *
   * The caller gets an id it can subscribe to before any work happens, which
   * is what makes the page able to show the first event rather than joining
   * halfway through.
   */
  async start(args: {
    chainId: number;
    agentId: number;
    apiKey: string;
    goal: string;
  }): Promise<{runId: number}> {
    const [run] = await this.deps.db
      .insert(runs)
      .values({
        chainId: args.chainId,
        agentId: args.agentId,
        goal: args.goal,
      })
      .returning();

    const runId = run!.id;
    void this.execute({...args, runId});
    return {runId};
  }

  private async execute(args: {runId: number; agentId: number; apiKey: string; goal: string}) {
    const emit = (event: RunEvent) => this.record(args.runId, event);

    try {
      const result = await this.deps.execute({...args, emit});

      // The terminal event is recorded BEFORE the row leaves `running`.
      //
      // The state is what every reader treats as "this run is complete" — the
      // demo page, the SDK, a test polling for it. Setting it first opened a
      // window where a run reported itself done while its last event was
      // still being written, so anything that read the trace at that instant
      // got a story missing its ending. Rare, which is what makes it nasty:
      // it surfaced as one flaky test in four full runs.
      await emit({kind: 'finished', delivered: result.delivered, spent: result.spent});

      await this.deps.db
        .update(runs)
        .set({
          state: 'done',
          answer: result.answer,
          steps: result.steps,
          spent: result.spent,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, args.runId));
    } catch (err) {
      // A run that throws must still end in a state the page can render.
      // "Running forever" is the one outcome a viewer cannot interpret.
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log?.(err, `run ${args.runId} failed`);

      // Same ordering as the success path, for the same reason: the terminal
      // event must be durable before the state says the run has ended.
      await emit({kind: 'failed', detail}).catch(() => undefined);

      await this.deps.db
        .update(runs)
        .set({state: 'failed', error: detail, finishedAt: new Date()})
        .where(eq(runs.id, args.runId))
        .catch(() => undefined);
    }
  }

  /** Persist first, then publish. The row is the record; the stream is a view of it. */
  private async record(runId: number, event: RunEvent): Promise<void> {
    const {kind, ...payload} = event;
    await this.deps.db.insert(runEvents).values({runId, kind, payload});
    this.deps.bus.publish(runId, {event: kind, data: payload});
  }
}
