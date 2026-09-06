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

/**
 * OpenRouter, OpenAI-compatible.
 *
 * A single key reaching many vendors, which is what makes it the right backend
 * for a harness whose job is comparing them on identical inputs. Note the cost
 * of that convenience: a request is routed to whichever upstream provider
 * OpenRouter picks, so the model is reproducible but the *jurisdiction* is not.
 * That is why routing.ts gives it `multi-region` residency and the default
 * policy refuses it — see docs/adr/0003-model-portability.md.
 *
 * Reasoning models need handling here, and getting it wrong is expensive in a
 * way that is hard to see. `max_tokens` bounds reasoning AND content together,
 * so a model that thinks for 163 tokens inside a 200-token budget returns an
 * empty string with `finish_reason: 'stop'`. That scores as a critical
 * `non_empty` failure and reads as a catastrophic model regression, which sends
 * someone off to bisect a prompt that was fine — the same trap judge.ts guards
 * against when a verdict comes back unparseable. GLM 5.3 Flash cannot disable
 * reasoning at all ("Reasoning is mandatory for this endpoint"), so the answer
 * is to ask for the least of it and to budget for it separately.
 */
/**
 * Extra tokens granted on top of the caller's turn budget, for models that
 * think before answering.
 *
 * Sized from measured runs rather than guessed: GLM 5.3 Flash at
 * `effort: 'minimal'` usually spends ~50 tokens, but a French opening turn
 * took 712, so `minimal` is a hint and not a cap. Generous on purpose — the
 * headroom is only ever spent by models that need it, at a fraction of a cent,
 * and the failure it prevents is an empty turn that reads as a quality
 * collapse. A model that exhausts even this errors by name rather than
 * returning nothing.
 */
const REASONING_HEADROOM_TOKENS = 512;

/**
 * How many times to re-ask when reasoning ate the whole budget.
 *
 * A fixed headroom is whack-a-mole: `effort: 'minimal'` is a hint, not a cap,
 * and the same model spent 50 tokens on one case and 1736 on another. So the
 * budget escalates instead of being guessed — doubling per attempt, bounded,
 * then failing by name. Same shape as the judge's retry in judge.ts, for the
 * same reason: a bounded retry is honest, a silent empty result is not.
 */
const MAX_BUDGET_ATTEMPTS = 3;

export class OpenRouterBackend implements EvalBackend {
  readonly id: string;
  #model: string;

  constructor(model = process.env.OPENROUTER_MODEL ?? 'z-ai/glm-5.3-flash-20260826') {
    this.#model = model;
    this.id = `openrouter:${model}`;
  }

  async complete(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('Set OPENROUTER_API_KEY');

    // The caller's budget is about the spoken turn. The provider's is about
    // everything the model emits, thinking included, so it is granted on top
    // rather than shared — otherwise the two budgets silently compete and the
    // turn is what loses.
    const turnTokens = options.maxTokens ?? 200;
    let headroom = REASONING_HEADROOM_TOKENS;
    let lastReason = '';

    for (let attempt = 1; attempt <= MAX_BUDGET_ATTEMPTS; attempt += 1) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: this.#model,
          messages,
          temperature: options.temperature ?? 0.6,
          max_tokens: turnTokens + headroom,
          // Ignored by models that do not reason; the ones that do are told to
          // spend as little as they can. An interviewer turn is one short
          // spoken question, and deliberation is latency the product cannot
          // afford — the same reason routing.ts prefers a non-reasoning default.
          reasoning: { effort: 'minimal' },
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter returned ${response.status}: ${await response.text()}`);
      }

      const body = (await response.json()) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
        usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
        // OpenRouter reports an upstream failure as a 200 with an error body,
        // which would otherwise surface as an empty turn and score as a model
        // regression rather than as the outage it is.
        error?: { message?: string };
      };
      if (body.error) {
        throw new Error(`OpenRouter upstream error: ${body.error.message ?? 'unknown'}`);
      }

      const choice = body.choices?.[0];
      const content = choice?.message?.content ?? '';
      if (content.length > 0) return content;

      const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      lastReason =
        reasoningTokens > 0
          ? `spent its whole budget reasoning (${reasoningTokens} tokens, ` +
            `finish_reason ${choice?.finish_reason ?? 'unknown'}, max_tokens ${turnTokens + headroom})`
          : `returned an empty turn (finish_reason ${choice?.finish_reason ?? 'unknown'})`;
      // Only a budget problem is worth re-asking. An empty turn with no
      // reasoning spent is the model declining, and repeating the request will
      // not change its mind.
      if (reasoningTokens === 0) break;
      headroom *= 2;
    }

    // Fail loudly and name the cause. An empty turn returned quietly is
    // indistinguishable from a model that has become terrible, and that is the
    // bisect nobody should be sent on.
    throw new Error(`${this.id} ${lastReason} after ${MAX_BUDGET_ATTEMPTS} attempts`);
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
    case 'openrouter':
      return new OpenRouterBackend();
    default:
      throw new Error(`Unknown backend "${name}". Use replay, azure, gemini or openrouter.`);
  }
}
