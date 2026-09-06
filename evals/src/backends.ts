import type { ChatMessage } from './deps.ts';

/**
 * Model backends for the harness.
 *
 * Two exist for two different jobs, and conflating them is why eval suites
 * either cost money on every commit or stop reflecting reality:
 *
 *  - `replay` serves each case's stored `referenceTurn`. Deterministic, free,
 *    no keys, so CI gates every pull request on the deterministic checks rather
 *    than on vendor noise. Note what this does and does not prove: it exercises
 *    the harness and catches a check regression, but it cannot catch a model
 *    regression until the turns are re-recorded from a live run.
 *  - `azure` / `gemini` call the real vendor. Run on demand and before a
 *    release to re-record, and to compare vendors on identical inputs.
 *
 * A prompt change invalidates the recordings, which is the point: the gate
 * refuses to pass a stale recording set (see gate.ts).
 */
export interface EvalBackend {
  id: string;
  complete(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

export class ReplayBackend implements EvalBackend {
  readonly id = 'replay';
  #turns: Map<string, string>;
  #current?: string;

  constructor(turns: Map<string, string>) {
    this.#turns = turns;
  }

  /** The runner names the case before each call; replay is keyed on it. */
  select(caseId: string): void {
    this.#current = caseId;
  }

  async complete(): Promise<string> {
    const turn = this.#current ? this.#turns.get(this.#current) : undefined;
    if (turn === undefined) {
      throw new Error(
        `No reference turn for case "${this.#current}". Run with --record against a live backend first.`,
      );
    }
    return turn;
  }
}

/** Minimal OpenAI-compatible chat completion, non-streaming. */
export class AzureBackend implements EvalBackend {
  readonly id: string;
  #deployment: string;

  constructor(deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o-mini') {
    this.#deployment = deployment;
    this.id = `azure:${deployment}`;
  }

  async complete(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '');
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!endpoint || !apiKey) {
      throw new Error('Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY');
    }
    const version = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';

    const response = await fetch(
      `${endpoint}/openai/deployments/${this.#deployment}/chat/completions?api-version=${version}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          messages,
          temperature: options.temperature ?? 0.6,
          max_tokens: options.maxTokens ?? 200,
        }),
      },
    );
    if (!response.ok) throw new Error(`Azure returned ${response.status}: ${await response.text()}`);

    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content ?? '';
  }
}

export class GeminiBackend implements EvalBackend {
  readonly id: string;
  #model: string;

  constructor(model = process.env.GEMINI_MODEL ?? 'gemini-3-flash') {
    this.#model = model;
    this.id = `gemini:${model}`;
  }

  async complete(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

    const system = messages.filter((m) => m.role === 'system');
    const turns = messages.filter((m) => m.role !== 'system');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.#model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(system.length > 0
            ? { systemInstruction: { parts: system.map((m) => ({ text: m.content })) } }
            : {}),
          contents: turns.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            temperature: options.temperature ?? 0.6,
            maxOutputTokens: options.maxTokens ?? 200,
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini returned ${response.status}: ${await response.text()}`);

    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }
}

export function makeBackend(name: string, recorded: Map<string, string>): EvalBackend {
  switch (name) {
    case 'replay':
      return new ReplayBackend(recorded);
    case 'local':
      // Constructed by the CLI, which knows the chosen model. Kept out of this
      // switch so the module does not pull the ONNX runtime into every run.
      throw new Error("Use --backend=local with --model=<repo>; the CLI builds it directly.");
    case 'azure':
      return new AzureBackend();
    case 'gemini':
      return new GeminiBackend();
    default:
      throw new Error(`Unknown backend "${name}". Use replay, azure or gemini.`);
  }
}
