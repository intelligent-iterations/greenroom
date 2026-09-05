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
  TextStreamer,
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

    const inputs = tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      return_dict: true,
    });

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
        max_new_tokens: options.maxTokens ?? 160,
        do_sample: true,
        temperature: options.temperature ?? 0.6,
        streamer,
      })
      .catch((err: unknown) => {
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
  }

  async unload(): Promise<void> {
    await this.#model?.dispose();
    this.#model = undefined;
    this.#tokenizer = undefined;
  }
}
