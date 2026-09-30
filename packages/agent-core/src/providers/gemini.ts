import {JsonHttpBrain} from './json-provider.js';
import type {CompletionRequest} from '../brain.js';

/**
 * Google Gemini, free tier.
 *
 * The most generous free allowance of the three (~1,500 requests/day, about
 * 500 AGENTX demo runs), and it accepts a response schema natively rather
 * than being asked nicely for JSON.
 */
export class GeminiBrain extends JsonHttpBrain {
  readonly name = 'gemini';
  protected readonly model: string;

  constructor(
    // gemini-2.5-flash answered 404 "no longer available to new users" on
    // 2026-09-30, naming this as its replacement. GEMINI_MODEL overrides it.
    model = process.env['GEMINI_MODEL'] ?? 'gemini-3.8-flash',
    private readonly apiKey = process.env['GEMINI_API_KEY'],
  ) {
    super();
    this.model = model;
  }

  protected endpoint(): string | null {
    return this.apiKey
      ? `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`
      : null;
  }

  protected buildRequest(req: CompletionRequest<unknown>, jsonSchema: object) {
    return {
      // In a header, never the query string. A URL is what ends up in error
      // messages, proxy logs and traces; a key in one is a key in all of them.
      url: this.endpoint()!,
      headers: {'x-goog-api-key': this.apiKey!},
      body: {
        systemInstruction: {parts: [{text: req.system}]},
        contents: [{role: 'user', parts: [{text: req.prompt}]}],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: jsonSchema,
          maxOutputTokens: req.maxTokens ?? 2_000,
        },
      },
    };
  }

  protected extractText(payload: unknown): string | null {
    const p = payload as {candidates?: {content?: {parts?: {text?: string}[]}}[]};
    return p.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') || null;
  }
}
