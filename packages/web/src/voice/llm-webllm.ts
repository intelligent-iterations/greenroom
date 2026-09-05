import {
  ThinkingStripper,
  type ChatMessage,
  type GenerateOptions,
  type LanguageModel,
  type LoadProgress,
} from '@greenroom/shared';
import { CreateMLCEngine, type MLCEngine } from '@mlc-ai/web-llm';

/**
 * On-device LLM via WebLLM (MLC), WebGPU only.
 *
 * There is no CPU fallback for this stage and that is a deliberate limit rather
 * than an oversight: a 1-2B model decoding on WASM is orders of magnitude
 * slower than on WebGPU, far outside the conversational budget in pipeline.ts.
 * A voice partner that takes several seconds to begin replying is not a slower
 * product, it is a different and worse one. When WebGPU
 * is absent the router falls back to a cloud model (see routing.ts) or, if the
 * learner has refused cloud inference, the app tells them plainly that this
 * device cannot run the private mode rather than degrading into something
 * unusable and blaming their machine.
 *
 * Weights are ~1.1GB and cached by the browser after first load.
 */
export interface WebLlmOptions {
  /** An MLC model id, e.g. 'Qwen3-1.7B-q4f16_1-MLC'. */
  model: string;
}

export class WebLlmModel implements LanguageModel {
  readonly id: string;
  #engine?: MLCEngine;
  #model: string;

  constructor(options: WebLlmOptions) {
    this.#model = options.model;
    this.id = `webllm:${options.model}`;
  }

  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.#engine) return;
    this.#engine = await CreateMLCEngine(this.#model, {
      initProgressCallback: (report) => {
        onProgress?.({ stage: report.text || 'language model', progress: report.progress });
      },
    });
  }

  /**
   * Runs one throwaway generation to force shader compilation.
   *
   * The first generation after load compiles GPU kernels, and that cost would
   * otherwise land on the opening question. The system prompt is passed so the
   * warm-up prefills a realistic prompt length rather than a two-token one.
   *
   * Failure here is deliberately swallowed: a warm-up is an optimisation, and
   * refusing to start a session because the optimisation failed would be worse
   * than a slow first turn.
   */
  async warmUp(systemPrompt: string): Promise<void> {
    const engine = this.#engine;
    if (!engine) return;
    try {
      await engine.chat.completions.create({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Hello.' },
        ],
        stream: false,
        max_tokens: 1,
        temperature: 0,
        extra_body: { enable_thinking: false },
      });
      // The warm-up turn must not be part of the interview's context.
      await engine.resetChat();
    } catch (err) {
      console.warn('model warm-up failed; first turn will be slower', err);
    }
  }

  async *generate(messages: ChatMessage[], options: GenerateOptions = {}): AsyncIterable<string> {
    const engine = this.#engine;
    if (!engine) throw new Error('WebLlmModel.load() must be awaited before generate()');

    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      // Low but non-zero. At 0 the interviewer reuses the same three follow-up
      // phrasings across a session and learners notice within two turns.
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? 160,
      // Qwen3-family models reason before answering unless told not to. For a
      // spoken interviewer that is strictly bad: it adds seconds of silence
      // before the first word and produces nothing the learner should hear.
      // WebLLM implements this by prepending an empty think block, so the
      // stripper below still has something to remove.
      extra_body: { enable_thinking: false },
    });

    // Second line of defence. `enable_thinking` is silently ignored by models
    // that do not implement it, and reasoning text reaching the synthesiser
    // would be read aloud to the learner in the interviewer's voice.
    const stripper = new ThinkingStripper();

    try {
      for await (const chunk of stream) {
        if (options.signal?.aborted) break;
        const delta = chunk.choices[0]?.delta?.content;
        if (!delta) continue;
        const speakable = stripper.push(delta);
        if (speakable) yield speakable;
      }
      if (!options.signal?.aborted) {
        const tail = stripper.flush();
        if (tail) yield tail;
      }
    } finally {
      // Barge-in leaves the engine mid-decode. Without this the next turn
      // inherits a half-finished KV cache and answers the previous question.
      if (options.signal?.aborted) await engine.interruptGenerate();
    }
  }

  async unload(): Promise<void> {
    await this.#engine?.unload();
    this.#engine = undefined;
  }
}
