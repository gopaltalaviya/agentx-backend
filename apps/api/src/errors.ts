import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {ZodError} from 'zod';
import {AgentxError, ErrorCode, ERROR_STATUS} from '@agentx/shared';

/**
 * RFC 7807 problem details for every failure.
 *
 * Agents branch on `code`, never on a message string. A human-readable message
 * is for the logs; a stable machine code is what lets an orchestrator decide
 * between "try another candidate" and "stop, the budget is gone".
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const err = error as Error & {validation?: unknown; statusCode?: number};
    const traceId = request.id;

    if (err instanceof AgentxError) {
      const problem = err.toProblem(titleFor(err.code));
      if (problem.retryAfter) reply.header('retry-after', String(problem.retryAfter));
      return reply.status(problem.status).type('application/problem+json').send({...problem, traceId});
    }

    // A malformed request is the caller's fault, not ours. Zod throws a
    // ZodError from .parse(), which is NOT Fastify's `validation` field — so
    // without this branch every bad body returned an opaque 500 and an agent
    // could not tell "I sent nonsense" from "the server broke".
    if (err instanceof ZodError) {
      return reply
        .status(422)
        .type('application/problem+json')
        .send({
          type: 'https://agentx.dev/errors/schema-mismatch',
          title: 'Request failed validation',
          status: 422,
          code: ErrorCode.SCHEMA_MISMATCH,
          detail: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
          traceId,
        });
    }

    // Fastify's own schema validation, surfaced in the same shape.
    if ((err as {validation?: unknown}).validation) {
      return reply
        .status(422)
        .type('application/problem+json')
        .send({
          type: 'https://agentx.dev/errors/schema-mismatch',
          title: 'Request failed validation',
          status: 422,
          code: ErrorCode.SCHEMA_MISMATCH,
          detail: err.message,
          traceId,
        });
    }

    // Postgres 23505. Registering a wallet that already has an agent is a
    // conflict the caller can act on, not an internal fault — returning 500
    // told them to retry something that can never succeed.
    if ((err as {code?: string}).code === '23505') {
      return reply
        .status(409)
        .type('application/problem+json')
        .send({
          type: 'https://agentx.dev/errors/already-exists',
          title: 'Already registered',
          status: 409,
          code: 'ALREADY_EXISTS',
          detail: 'an agent already exists for that wallet on this chain',
          traceId,
        });
    }

    if ((err as {statusCode?: number}).statusCode === 429) {
      return reply.status(429).type('application/problem+json').send({
        type: 'https://agentx.dev/errors/rate-limited',
        title: 'Too many requests',
        status: 429,
        code: 'RATE_LIMITED',
        detail: err.message,
        traceId,
      });
    }

    request.log.error({err, traceId}, 'unhandled error');
    // Never leak an internal message to a caller; the traceId is how support
    // connects this response to the log line that has the detail.
    return reply.status(500).type('application/problem+json').send({
      type: 'https://agentx.dev/errors/internal',
      title: 'Internal error',
      status: 500,
      code: 'INTERNAL',
      traceId,
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).type('application/problem+json').send({
      type: 'https://agentx.dev/errors/not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: `${request.method} ${request.url}`,
      traceId: request.id,
    }),
  );
}

const TITLES: Record<string, string> = {
  [ErrorCode.AGENT_NOT_HIREABLE]: 'Agent is not hireable',
  [ErrorCode.PRICE_ABOVE_MAX]: 'Price exceeds maxPrice',
  [ErrorCode.BUDGET_EXCEEDED]: 'Spending cap reached',
  [ErrorCode.INSUFFICIENT_FUNDS]: 'Insufficient funds',
  [ErrorCode.INVALID_STATE]: 'Illegal state transition',
  [ErrorCode.DEADLINE_PASSED]: 'Deadline has passed',
  [ErrorCode.SCHEMA_MISMATCH]: 'Result failed schema validation',
  [ErrorCode.IDEMPOTENCY_CONFLICT]: 'Idempotency key conflict',
  [ErrorCode.CHAIN_MISMATCH]: 'Wrong chain for this agent',
  [ErrorCode.CHAIN_NOT_ENABLED]: 'Chain not enabled',
};

function titleFor(code: string): string {
  return TITLES[code] ?? 'Request failed';
}

export {ERROR_STATUS};
