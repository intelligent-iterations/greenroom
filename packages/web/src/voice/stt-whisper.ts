import type { LoadProgress, SpeechRecognizer, TranscriptionResult } from '@greenroom/shared';
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { detectCapabilities } from './capabilities.js';
import { findStage } from './model-manifest.js';

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
 * Quantisation is per-module and comes from the shared manifest, not from a
 * single dtype string. Whisper loads an encoder and a merged decoder, and they
 * do not want the same precision: on WebGPU both stay full precision, and on
 * the WASM fallback only the decoder is quantised. We previously passed one
 * `fp16` for everything, which quantised the encoder — precisely the component
 * whose precision governs accuracy on accented speech, which is the population
 * this product exists to serve. The configuration now matches Hugging Face's
 * own working browser voice-chat example.
 */
export interface WhisperOptions {
  model?: string;
  language?: 'en' | 'fr';
}

const DEFAULT_MODEL = findStage('stt').repo;

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
    // Typed as the manifest's Dtype union, so this cast is narrowing to the
    // library's identical union rather than asserting something unchecked.
    const dtype = findStage('stt').modules[device] as Record<string, 'fp32' | 'q8'>;

    this.#asr = (await pipeline('automatic-speech-recognition', this.#model, {
      device,
      dtype,
      progress_callback: (p: { status?: string; progress?: number; loaded?: number; total?: number }) => {
        onProgress?.({
          stage: `speech recognition (${device})`,
          progress: (p.progress ?? 0) / 100,
          ...(p.loaded !== undefined ? { loaded: p.loaded } : {}),
          ...(p.total !== undefined ? { total: p.total } : {}),
        });
      },
    })) as AutomaticSpeechRecognitionPipeline;

    // Shader compilation on the first real utterance would add hundreds of
    // milliseconds to the learner's first answer. One second of silence gets it
    // out of the way while the loading screen is still up, as the reference
    // implementation does.
    await this.#asr(new Float32Array(16_000), { language: this.#language });
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
