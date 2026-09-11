import {
  AutoModelForCausalLM,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import type { ChatMessage } from './deps.ts';
import type { EvalBackend } from './backends.ts';

/**
 * Runs the on-device model natively, in Node.
 *
 * The browser eval runner exists because the offline harness could not reach
 * the model that ships. It works, and it is a bad place to live: a backgrounded
 * Chrome tab is throttled to a crawl, the run dies with the page, and driving
 * it needs a debugger connection that repeatedly lost completed runs.
 *
 * None of that is necessary, because **behaviour does not depend on the
 * accelerator**. Whether a turn asks a question, stays in role, or leaks an
 * answer is a property of the model and the prompt. WebGPU changes how fast the
 * tokens arrive, not what they say. So the checks run here, on CPU, in a
 * process that can be scripted and put in CI — and `bench.html` keeps the job
 * that genuinely needs a GPU, which is measuring latency.
 *
 * The trade is speed: CPU decoding is far slower than WebGPU. That is
 * acceptable for a suite that runs on a change, and it is why `--limit` and the
 * smaller models exist.
 */
export interface LocalBackendOptions {
  /** Hugging Face repo, or a local directory when `env.allowLocalModels`. */
  model: string;
  /** onnxruntime dtype. q4 is the practical default on CPU. */
  dtype?: 'q4' | 'q4f16' | 'q8' | 'fp32';
  /** Where weights are cached between runs. */
  cacheDir?: string;
}

export class LocalBackend implements EvalBackend {
  readonly id: string;
  #model?: PreTrainedModel;
  #tokenizer?: PreTrainedTokenizer;
  #options: Required<Pick<LocalBackendOptions, 'model' | 'dtype'>> & { cacheDir?: string };

  constructor(options: LocalBackendOptions) {
    this.#options = {
      model: options.model,
      // q4f16 is a GPU quantisation; on CPU the fp16 blocks are emulated and
      // it is slower than plain q4 for no accuracy gain worth having.
      dtype: options.dtype ?? 'q4',
      // Default to a cache beside the repository rather than inside
      // node_modules, which an install wipes — re-downloading gigabytes
      // because someone ran `pnpm install` is a bad trade.
      cacheDir: options.cacheDir ?? new URL('../../.model-cache/', import.meta.url).pathname,
    };
    this.id = `local:${options.model}`;
  }

  async load(onProgress?: (message: string) => void): Promise<void> {
    if (this.#model) return;
    if (this.#options.cacheDir) env.cacheDir = this.#options.cacheDir;

    let lastReported = -1;
    const progress = (info: unknown) => {
      if (!onProgress) return;
      const pct =
        typeof info === 'object' && info !== null && 'progress' in info &&
        typeof (info as { progress: unknown }).progress === 'number'
          ? Math.floor((info as { progress: number }).progress)
          : -1;
      // Only on whole-percent changes: a progress callback per chunk floods a
      // terminal and tells the reader nothing extra.
      if (pct >= 0 && pct !== lastReported) {
        lastReported = pct;
        onProgress(`downloading ${pct}%`);
      }
    };

    this.#tokenizer = await AutoTokenizer.from_pretrained(this.#options.model, {
      progress_callback: progress,
    });
    this.#model = await AutoModelForCausalLM.from_pretrained(this.#options.model, {
      dtype: this.#options.dtype,
      progress_callback: progress,
    });
  }

  async complete(
    messages: ChatMessage[],
    options: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    const model = this.#model;
    const tokenizer = this.#tokenizer;
    if (!model || !tokenizer) throw new Error('LocalBackend.load() must be awaited first');

    const inputs = tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      return_dict: true,
    });

    const output = await model.generate({
      ...(inputs as object),
      max_new_tokens: options.maxTokens ?? 120,
      // Greedy by default: an eval that changes its answer between runs cannot
      // tell a regression from noise. Sampling is available when the question
      // is about variety rather than correctness.
      do_sample: (options.temperature ?? 0) > 0,
      ...(options.temperature ? { temperature: options.temperature } : {}),
      return_dict_in_generate: false,
    });

    // Slice by token count, not by string prefix.
    //
    // `generate` returns prompt + completion. Stripping the prompt by decoding
    // the chat template and trimming that prefix does not work: the template
    // contains special tokens that `skip_special_tokens` removes from the
    // decode, so the two strings never line up and prompt fragments leak into
    // the result — which then gets scored as if the model had said them.
    const promptLength = (inputs as { input_ids: { dims: number[] } }).input_ids.dims[1] ?? 0;
    const sequences = output as unknown as { tolist(): number[][] };
    const generated = (sequences.tolist()[0] ?? []).slice(promptLength);
    return (tokenizer.decode(generated, { skip_special_tokens: true }) ?? '').trim();
  }

  async unload(): Promise<void> {
    await this.#model?.dispose();
    this.#model = undefined;
  }
}
