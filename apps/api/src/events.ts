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
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // nginx buffers SSE into uselessness otherwise
  });

  const send = (e: StreamEvent) => {
    reply.raw.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
  };

  // Replay what already happened, so a client that connects late sees the
  // whole story rather than joining halfway through.
  for (const e of replay) send(e);

  const unsubscribe = bus.subscribe(topicId, send);
  const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  };

  reply.raw.on('close', close);
  reply.raw.on('error', close);
}
