import {zodToJsonSchema} from 'zod-to-json-schema';
import {
  BrainInvalidOutput,
  BrainUnavailable,
  type Brain,
  type CompletionRequest,
  type CompletionResult,
} from '../brain.js';

/**
 * Shared base for providers reached over plain HTTP with a JSON-mode API.
 *
 * Gemini, Groq and Ollama all express "give me JSON matching this schema" in
 * slightly different shapes. The differences are small enough that one base
 * with a per-provider request builder is less code — and far less drift —
 * than three near-identical adapters.
 *
 * Every response is validated against the caller's zod schema before it is
 * returned. A provider advertising JSON mode is not a guarantee, and an
 * unvalidated result reaching a worker becomes a failed job and a reputation
 * hit on-chain.
 */
export abstract class JsonHttpBrain implements Brain {
  abstract readonly name: string;
  protected abstract readonly model: string;

  protected abstract endpoint(): string | null;
  protected abstract buildRequest(
    req: CompletionRequest<unknown>,
    jsonSchema: object,
  ): {url: string; headers: Record<string, string>; body: unknown};
  protected abstract extractText(payload: unknown): string | null;

  async complete<T>(req: CompletionRequest<T>): Promise<CompletionResult<T>> {
    if (!this.endpoint()) {
      throw new BrainUnavailable(this.name, 'not_configured', 'no API key or endpoint configured');
    }

    const jsonSchema = zodToJsonSchema(req.schema, {target: 'jsonSchema7'}) as object;
    const {url, headers, body} = this.buildRequest(req, jsonSchema);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...headers},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new BrainUnavailable(this.name, 'timeout', (err as Error).message);
    }

    if (res.status === 429) throw new BrainUnavailable(this.name, 'rate_limit', 'rate limited');
    if (res.status === 401 || res.status === 403) {
      throw new BrainUnavailable(this.name, 'auth', `rejected the key (${res.status})`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new BrainUnavailable(this.name, 'outage', `${res.status} ${detail.slice(0, 200)}`);
    }

    const text = this.extractText(await res.json());
    if (!text) throw new BrainInvalidOutput(this.name, 'response contained no text');

    let raw: unknown;
    try {
      raw = JSON.parse(stripFences(text));
    } catch {
      // Not retryable elsewhere: a model ignoring JSON mode is a prompt
      // problem, and the next provider would likely do the same.
      throw new BrainInvalidOutput(this.name, `not valid JSON: ${text.slice(0, 160)}`);
    }

    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new BrainInvalidOutput(
        this.name,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    return {value: parsed.data, provider: this.name, model: this.model, cached: false};
  }

  async available(): Promise<boolean> {
    return this.endpoint() !== null;
  }
}

/** Some models wrap JSON in code fences despite being told not to. */
function stripFences(text: string): string {
  const fence = String.fromCharCode(96).repeat(3);
  const re = new RegExp('^\\s*' + fence + '(?:json)?\\s*\\n([\\s\\S]*?)\\n\\s*' + fence + '\\s*$');
  return re.exec(text)?.[1] ?? text.trim();
}
