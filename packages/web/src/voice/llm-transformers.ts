import {
  ThinkingStripper,
  type ChatMessage,
  type GenerateOptions,
  type LanguageModel,
  type LoadProgress,
} from '@greenroom/shared';
import {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  TextStreamer,
  type DynamicCache,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import { detectCapabilities } from './capabilities.js';
import { findStage } from './model-manifest.js';

/**
 * On-device LLM via transformers.js / ONNX Runtime Web.
 *
 * Replaces the WebLLM (MLC) adapter as the default for one decisive reason:
 * MLC ships compiled shader libraries and weights as separate artifacts, and it
 * has published ids whose weights are missing — Qwen3.5 and Ministral 3 both
 * fail at load today. transformers.js loads ONNX weights straight from the
 * Hugging Face repository, so the artifact that gets verified by `pnpm
 * preflight` is exactly the artifact that gets fetched.
 *
 * It also collapses the runtime: recognition, generation and synthesis now
 * share one ONNX runtime and one browser cache instead of two of each.
 *
 * The model, dtype and device match Hugging Face's `conversational-webgpu`
 * example — a published, working in-browser voice chat on this stack. Matching
 * a proven configuration beat reasoning about which quantisation ought to work.
 */
export interface TransformersLlmOptions {
  /** Overrides the manifest entry. Must exist in the manifest to preflight. */
  model?: string;
  dtype?: string;
}

export class TransformersLanguageModel implements LanguageModel {
  readonly id: string;
  #model?: PreTrainedModel;
  #tokenizer?: PreTrainedTokenizer;
  #repo: string;
  #dtype: string;
  /**
   * Attention cache carried between turns.
   *
   * Without it every turn re-prefills the whole conversation, and the
   * interviewer's system prompt alone is several hundred tokens — which is most
   * of the delay before the first spoken word. With it, a turn only prefills
   * what the learner just said.
   */
  #pastKeyValues: DynamicCache | undefined;
  /** The conversation the cache belongs to, for detecting a reset. */
  #cachedMessages: ChatMessage[] = [];

  constructor(options: TransformersLlmOptions = {}) {
    const spec = findStage('llm');
    this.#repo = options.model ?? spec.repo;
    this.#dtype = options.dtype ?? spec.modules.webgpu['model'] ?? 'q4f16';
    this.id = `transformers:${this.#repo}`;
  }

  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.#model) return;
    const caps = await detectCapabilities();
    if (!caps.hasWebGpu) {
      // Deliberate: a 1.7B model decoding on WASM is far outside the
      // conversational budget. The router sends these devices to a cloud model
      // rather than degrading into something unusable and blaming the machine.
      throw new Error('On-device generation requires WebGPU');
    }

    this.#tokenizer = await AutoTokenizer.from_pretrained(this.#repo);
    this.#model = await AutoModelForCausalLM.from_pretrained(this.#repo, {
      dtype: this.#dtype as 'q4f16',
      device: 'webgpu',
      progress_callback: (info: { status?: string; progress?: number }) =>
        onProgress?.({
          stage: 'language model',
          progress: (info.progress ?? 0) / 100,
        }),
    });
  }

  /**
   * Compiles shaders with a one-token generation.
   *
   * The reference implementation does the same thing for the same reason: the
   * first generation after load pays shader compilation, and that cost would
   * otherwise land on the opening question.
   */
  async warmUp(systemPrompt: string): Promise<void> {
    if (!this.#model || !this.#tokenizer) return;
    try {
      const inputs = this.#tokenizer.apply_chat_template(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Hello.' },
        ],
        { add_generation_prompt: true, return_dict: true },
      );
      await this.#model.generate({ ...(inputs as object), max_new_tokens: 1 });
    } catch (err) {
      console.warn('model warm-up failed; first turn will be slower', err);
    }
  }

  async *generate(messages: ChatMessage[], options: GenerateOptions = {}): AsyncIterable<string> {
    const model = this.#model;
    const tokenizer = this.#tokenizer;
    if (!model || !tokenizer) {
      throw new Error('TransformersLanguageModel.load() must be awaited before generate()');
    }

    // The cache is only valid if this turn continues the conversation it was
    // built from. A debrief, or a new session, starts from different text, and
    // reusing the cache there would condition the reply on a conversation that
    // is no longer in the prompt.
    if (!this.#extendsCachedConversation(messages)) {
      this.#pastKeyValues = undefined;
    }

    const inputs = tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      return_dict: true,
    });

    // Real interruption. Breaking out of the consumer loop stops us reading
    // tokens but leaves the model decoding into a cache nobody will use, which
    // wastes the GPU exactly when the next turn needs it. This stops decode.
    const stopping = new InterruptableStoppingCriteria();
    const onAbort = () => stopping.interrupt();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // transformers.js streams through a callback rather than an async iterator,
    // so tokens are queued here and drained by the loop below. Without the
    // queue the callback would outrun the consumer and drop deltas.
    const queue: string[] = [];
    let notify: (() => void) | undefined;
    let finished = false;

    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        queue.push(text);
        notify?.();
      },
    });

    const stripper = new ThinkingStripper();

    const done = model
      .generate({
        ...(inputs as object),
        past_key_values: this.#pastKeyValues,
        max_new_tokens: options.maxTokens ?? 160,
        do_sample: true,
        temperature: options.temperature ?? 0.6,
        streamer,
        stopping_criteria: stopping,
        return_dict_in_generate: true,
      })
      .then((output: unknown) => {
        // Keep the cache so the next turn skips re-prefilling the transcript.
        this.#pastKeyValues = (output as { past_key_values?: DynamicCache })?.past_key_values;
      })
      .catch((err: unknown) => {
        // A failed turn must not leave a cache describing a state the model
        // never reached.
        this.#pastKeyValues = undefined;
        console.error('generation failed', err);
      })
      .finally(() => {
        finished = true;
        notify?.();
      });

    while (!finished || queue.length > 0) {
      if (options.signal?.aborted) break;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
        continue;
      }
      const speakable = stripper.push(queue.shift()!);
      if (speakable) yield speakable;
    }

    if (!options.signal?.aborted) {
      const tail = stripper.flush();
      if (tail) yield tail;
    }

    await done;
    options.signal?.removeEventListener('abort', onAbort);

    // Record what the cache now represents: the prompt plus what was actually
    // generated. On an interruption the model stopped early, so the cache no
    // longer matches any transcript we will send again and is dropped.
    if (options.signal?.aborted) {
      this.#pastKeyValues = undefined;
      this.#cachedMessages = [];
    } else {
      this.#cachedMessages = [...messages];
    }
  }

  /** True when `messages` begins with the conversation the cache was built on. */
  #extendsCachedConversation(messages: ChatMessage[]): boolean {
    if (this.#pastKeyValues === undefined) return false;
    if (messages.length < this.#cachedMessages.length) return false;
    return this.#cachedMessages.every(
      (cached, i) => messages[i]?.role === cached.role && messages[i]?.content === cached.content,
    );
  }

  /** Drops the attention cache. Call when starting a new conversation. */
  resetCache(): void {
    this.#pastKeyValues = undefined;
    this.#cachedMessages = [];
  }

  async unload(): Promise<void> {
    this.resetCache();
    await this.#model?.dispose();
    this.#model = undefined;
    this.#tokenizer = undefined;
  }
}
