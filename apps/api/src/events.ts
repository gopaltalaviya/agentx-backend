import type {FastifyReply} from 'fastify';

/**
 * Server-Sent Events for live job updates.
 *
 * SSE rather than WebSockets: the traffic is one-directional, it survives
 * proxies that mangle upgrades, and it reconnects on its own. The demo page
 * is the main consumer and it only ever listens.
 */

export interface JobEvent {
  event: string;
  data: Record<string, unknown>;
}

type Subscriber = (event: JobEvent) => void;

export class EventBus {
  private readonly byJob = new Map<number, Set<Subscriber>>();

  publish(jobId: number, event: JobEvent): void {
    for (const fn of this.byJob.get(jobId) ?? []) {
      try {
        fn(event);
      } catch {
        // A broken subscriber must never stop the others, and must never
        // propagate into the request that triggered the publish.
      }
    }
  }

  subscribe(jobId: number, fn: Subscriber): () => void {
    let set = this.byJob.get(jobId);
    if (!set) {
      set = new Set();
      this.byJob.set(jobId, set);
    }
    set.add(fn);

    return () => {
      set!.delete(fn);
      // Drop the key when the last listener leaves, or a long-running process
      // accumulates one empty Set per job it has ever served.
      if (set!.size === 0) this.byJob.delete(jobId);
    };
  }

  get subscriberCount(): number {
    let n = 0;
    for (const set of this.byJob.values()) n += set.size;
    return n;
  }
}

const HEARTBEAT_MS = 25_000;

/**
 * Stream a job's events to one client until it disconnects.
 *
 * The heartbeat is not decoration: proxies and load balancers close idle
 * connections, and a demo page that silently stops updating looks identical
 * to a demo that crashed.
 */
export function streamJobEvents(
  reply: FastifyReply,
  bus: EventBus,
  jobId: number,
  replay: JobEvent[] = [],
): void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // nginx buffers SSE into uselessness otherwise
  });

  const send = (e: JobEvent) => {
    reply.raw.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  };

  // Replay what already happened, so a client that connects mid-job sees the
  // whole story rather than joining halfway through.
  for (const e of replay) send(e);

  const unsubscribe = bus.subscribe(jobId, send);
  const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  };

  reply.raw.on('close', close);
  reply.raw.on('error', close);
}
