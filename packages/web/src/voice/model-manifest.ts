/**
 * The exact ONNX artifacts every on-device stage will request.
 *
 * This exists because "the model is listed" is not the same as "the model
 * loads". We shipped a catalogue entry for Qwen3.5 that passed a unit test
 * asserting its id was in WebLLM's registry, and it still failed at load
 * because MLC had published the compiled library but not the weights. The
 * failure surfaced as an opaque cache error, tens of seconds in, on the
 * learner's device.
 *
 * So the configuration is declared here as data, the adapters read it, and
 * `pnpm preflight` resolves it to concrete URLs and checks every one of them
 * before anybody downloads a gigabyte. The adapters and the checker cannot
 * disagree, because there is only one description.
 *
 * The stage configuration mirrors Hugging Face's own `conversational-webgpu`
 * example, which is a published, working browser voice-chat pipeline on this
 * exact stack. Where we differed from it we were wrong, so we now match it and
 * note the deviations explicitly.
 */

export type Device = 'webgpu' | 'wasm';

/**
 * Quantisations transformers.js accepts. Kept as a literal union rather than
 * `string` so a typo in the manifest is a compile error, not a 404 at runtime.
 */
export type Dtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'q4f16' | 'bnb4';

/**
 * transformers.js dtype -> ONNX filename suffix.
 *
 * Deterministic and total, which is what makes static verification possible:
 * given a repo, a module and a dtype, the URL is known without running
 * anything. Derived from the file naming in the published repositories.
 */
const DTYPE_SUFFIX: Record<Dtype, string> = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  q4f16: '_q4f16',
  bnb4: '_bnb4',
};

export function onnxFileName(moduleName: string, dtype: string): string {
  const suffix = DTYPE_SUFFIX[dtype as Dtype];
  if (suffix === undefined) throw new Error(`Unknown dtype "${dtype}"`);
  return `onnx/${moduleName}${suffix}.onnx`;
}

export interface StageSpec {
  stage: 'vad' | 'stt' | 'llm' | 'tts';
  repo: string;
  /** ONNX module names this stage loads, and their dtype per device. */
  modules: Record<Device, Record<string, Dtype>>;
  /** Non-ONNX files that must also resolve (tokenizer, config). */
  extraFiles: string[];
  /**
   * Config supplied by the caller instead of fetched.
   *
   * Some repositories ship weights with no `config.json`; the loader must be
   * handed one. Recorded here so preflight does not demand a file that is
   * correctly absent, and so the reason is written down next to the fact.
   */
  inlineConfig?: Record<string, string>;
}

export const MODEL_MANIFEST: StageSpec[] = [
  {
    stage: 'stt',
    repo: 'onnx-community/whisper-base',
    // Per-module dtypes, matching the reference implementation. We previously
    // passed a single `fp16` for every module on WebGPU; the reference uses
    // full precision for both, and encoder precision is exactly what degrades
    // accented speech — the population this product exists to serve.
    modules: {
      webgpu: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
      wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    },
    extraFiles: ['config.json', 'tokenizer.json', 'preprocessor_config.json'],
  },
  {
    stage: 'llm',
    repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    // q4f16 on WebGPU is the reference's choice and the only quantisation at
    // this size that keeps weights small enough to sit alongside Whisper and
    // Kokoro in one tab.
    //
    // The wasm entry is here so the stage resolves on a CPU-only machine, not
    // because a 1.7B model decoding on CPU is a good idea — it is far outside
    // the conversational budget. An earlier version of this comment claimed
    // there was no wasm entry and that the router fell back to a cloud model
    // instead; both halves are now wrong. There is an entry, and cloud is off
    // by default. `assessReadiness` is what tells someone on such a machine
    // what to expect, and it points them at the 360M tier rather than this one.
    modules: {
      webgpu: { model: 'q4f16' },
      wasm: { model: 'q4f16' },
    },
    extraFiles: ['config.json', 'tokenizer.json', 'tokenizer_config.json'],
  },
  {
    stage: 'tts',
    repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    modules: {
      webgpu: { model: 'fp32' },
      wasm: { model: 'q8' },
    },
    extraFiles: ['config.json', 'tokenizer.json'],
  },
  {
    stage: 'vad',
    // Verified by preflight: this repository has no config.json, so the loader
    // is handed one. Discovered by the check rather than by a failed download.
    repo: 'onnx-community/silero-vad',
    modules: {
      webgpu: { model: 'fp32' },
      wasm: { model: 'fp32' },
    },
    extraFiles: [],
    inlineConfig: { model_type: 'custom' },
  },
];

/** Every file a stage will fetch on a given device, as repo-relative paths. */
export function expectedFiles(spec: StageSpec, device: Device): string[] {
  const modules = Object.entries(spec.modules[device]).map(([name, dtype]) =>
    onnxFileName(name, dtype),
  );
  return [...modules, ...spec.extraFiles];
}

export function huggingFaceUrl(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

export function findStage(stage: StageSpec['stage']): StageSpec {
  const found = MODEL_MANIFEST.find((s) => s.stage === stage);
  if (!found) throw new Error(`No manifest entry for stage "${stage}"`);
  return found;
}
