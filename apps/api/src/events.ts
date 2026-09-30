import type {FastifyReply} from 'fastify';

/**
 * Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-directional, it survives
 * proxies that mangle upgrades, and it reconnects on its own. The demo page
 * is the main consumer and it only ever listens.
 *
 * The bus is keyed by a numeric topic — a job id on one instance, a run id on
 * another. Two instances rather than one shared namespace, because job 7 and
 * run 7 are unrelated and a single map keyed by number would quietly deliver
 * one's events to the other's subscribers.
 */

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

type Subscriber = (event: StreamEvent) => void;

export class EventBus {
  private readonly byTopic = new Map<number, Set<Subscriber>>();
  /** Open SSE streams, so shutdown can end them rather than wait on them. */
  private readonly streams = new Set<() => void>();

  /**
   * @param maxStreams open SSE connections this instance will hold. Each is a
   *   socket and a heartbeat timer; without a ceiling one client could open
   *   them until the process ran out of file descriptors.
   */
  constructor(readonly maxStreams = 1_000) {}

  get streamCount(): number {
    return this.streams.size;
  }

  /** @internal */
  track(close: () => void): () => void {
    this.streams.add(close);
    return () => this.streams.delete(close);
  }

  /**
   * End every open stream. Called on shutdown: an SSE connection never ends
   * by itself, so without this `app.close()` waited out the shutdown timeout
   * on every deploy. The client's EventSource reconnects to a live instance.
   */
  closeAll(): void {
    for (const close of [...this.streams]) close();
  }

  publish(topicId: number, event: StreamEvent): void {
    for (const fn of this.byTopic.get(topicId) ?? []) {
      try {
        fn(event);
      } catch {
        // A broken subscriber must never stop the others, and must never
        // propagate into the request that triggered the publish.
      }
    }
  }

  subscribe(topicId: number, fn: Subscriber): () => void {
    let set = this.byTopic.get(topicId);
    if (!set) {
      set = new Set();
      this.byTopic.set(topicId, set);
    }
    set.add(fn);

    return () => {
      set!.delete(fn);
      // Drop the key when the last listener leaves, or a long-running process
      // accumulates one empty Set per job it has ever served.
      if (set!.size === 0) this.byTopic.delete(topicId);
    };
  }

  get subscriberCount(): number {
    let n = 0;
    for (const set of this.byTopic.values()) n += set.size;
    return n;
  }
}

const HEARTBEAT_MS = 25_000;

/**
 * Stream one topic's events to one client until it disconnects.
 *
 * The heartbeat is not decoration: proxies and load balancers close idle
 * connections, and a demo page that silently stops updating looks identical
 * to a demo that crashed.
 */
export function streamEvents(
  reply: FastifyReply,
  bus: EventBus,
  topicId: number,
  replay: StreamEvent[] = [],
): void {
  if (bus.streamCount >= bus.maxStreams) {
    reply.raw.writeHead(503, {'content-type': 'application/problem+json', 'retry-after': '5'});
    reply.raw.end(
      JSON.stringify({
        type: 'https://agentx.dev/errors/upstream-unavailable',
        title: 'Too many open streams',
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        detail: `this instance holds ${bus.maxStreams} streams; retry shortly`,
        retryAfter: 5,
      }),
    );
    return;
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // nginx buffers SSE into uselessness otherwise
  });
  // Send the headers NOW. Node holds them until the first write, so a client
  // watching a quiet run — nothing to replay, nothing published yet — saw no
  // response at all until the first heartbeat, 25 s later. The retry hint
  // tells EventSource how soon to reconnect after a deploy ends the stream.
  reply.raw.write('retry: 3000\n\n');

  const send = (e: StreamEvent) => {
    reply.raw.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  };

  // Replay what already happened, so a client that connects late sees the
  // whole story rather than joining halfway through.
  for (const e of replay) send(e);

  const unsubscribe = bus.subscribe(topicId, send);
  const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), HEARTBEAT_MS);

  let closed = false;
  const untrack = bus.track(() => close());
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    untrack();
    reply.raw.end();
  };

  reply.raw.on('close', close);
  reply.raw.on('error', close);
}
