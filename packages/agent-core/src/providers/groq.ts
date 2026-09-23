import {JsonHttpBrain} from './json-provider.js';
import type {CompletionRequest} from '../brain.js';

/**
 * Groq, free tier.
 *
 * The fastest inference of the three — often sub-second — which matters in a
 * live demo, where a worker that answers quickly reads as competent. The
 * binding free-tier limit is tokens per day rather than requests, so worker
 * prompts are kept deliberately short.
 */
export class GroqBrain extends JsonHttpBrain {
  readonly name = 'groq';
  protected readonly model: string;

  constructor(
    model = process.env['GROQ_MODEL'] ?? 'openai/gpt-oss-120b',
    private readonly apiKey = process.env['GROQ_API_KEY'],
  ) {
    super();
    this.model = model;
  }

  protected endpoint(): string | null {
    return this.apiKey ? 'https://api.groq.com/openai/v1/chat/completions' : null;
  }

  protected buildRequest(req: CompletionRequest<unknown>, jsonSchema: object) {
    return {
      url: this.endpoint()!,
      headers: {authorization: `Bearer ${this.apiKey}`},
      body: {
        model: this.model,
        max_tokens: req.maxTokens ?? 2_000,
        messages: [
          {role: 'system', content: req.system},
          {role: 'user', content: req.prompt},
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {name: req.schemaName, schema: jsonSchema, strict: true},
        },
      },
    };
  }

  protected extractText(payload: unknown): string | null {
    const p = payload as {choices?: {message?: {content?: string}}[]};
    return p.choices?.[0]?.message?.content ?? null;
  }
}
