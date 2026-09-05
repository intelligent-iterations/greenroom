import type { LoadProgress, SpeechRecognizer, TranscriptionResult } from '@greenroom/shared';
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { detectCapabilities } from './capabilities.js';

/**
 * Whisper via transformers.js, WebGPU with a WASM fallback.
 *
 * Model choice: whisper-base is the default because it is the smallest Whisper
 * that stays usable on the CPU fallback path, where the transcription budget is
 * tightest. -tiny is faster but its error rate on accented speech is the wrong
 * trade for a product whose users are, by definition, speaking a second
 * language; -small is more accurate but its CPU latency is the risk. Which of
 * base and small to ship is a measurement question, not a taste one —
 * docs/BENCHMARKS.md describes the comparison to run, and `model` is an option
 * here so both can be run through the same eval set.
 *
 * Quantisation differs by backend deliberately: fp16 on WebGPU, q8 on WASM.
 * Aggressive quantisation degrades exactly the accented speech this product
 * exists to serve, so the GPU path spends its headroom on precision rather than
 * on a larger model.
 */
export interface WhisperOptions {
  model?: string;
  language?: 'en' | 'fr';
}

const DEFAULT_MODEL = 'onnx-community/whisper-base';

export class WhisperRecognizer implements SpeechRecognizer {
  readonly id: string;
  #asr?: AutomaticSpeechRecognitionPipeline;
  #language: 'en' | 'fr';
  #model: string;

  constructor(options: WhisperOptions = {}) {
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#language = options.language ?? 'en';
    this.id = `whisper:${this.#model}`;
  }

  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.#asr) return;
    const caps = await detectCapabilities();
    const device = caps.hasWebGpu ? 'webgpu' : 'wasm';

    this.#asr = (await pipeline('automatic-speech-recognition', this.#model, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback: (p: { status?: string; progress?: number; loaded?: number; total?: number }) => {
        onProgress?.({
          stage: `speech recognition (${device})`,
          progress: (p.progress ?? 0) / 100,
          ...(p.loaded !== undefined ? { loaded: p.loaded } : {}),
          ...(p.total !== undefined ? { total: p.total } : {}),
        });
      },
    })) as AutomaticSpeechRecognitionPipeline;
  }

  async transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptionResult> {
    if (!this.#asr) throw new Error('WhisperRecognizer.load() must be awaited before transcribe()');
    if (sampleRate !== 16_000) {
      // Resampling belongs to the capture layer, which owns the AudioContext.
      // Failing loudly here beats silently transcribing chipmunk audio.
      throw new Error(`Whisper requires 16kHz audio, received ${sampleRate}Hz`);
    }

    const output = await this.#asr(audio, {
      language: this.#language,
      task: 'transcribe',
      // Interview answers are one utterance; chunking adds latency and
      // introduces seam artefacts at boundaries.
      chunk_length_s: 30,
      return_timestamps: false,
    });

    const text = (Array.isArray(output) ? output[0]?.text : output.text) ?? '';
    return { text: text.trim(), language: this.#language };
  }

  async unload(): Promise<void> {
    await this.#asr?.dispose();
    this.#asr = undefined;
  }
}
