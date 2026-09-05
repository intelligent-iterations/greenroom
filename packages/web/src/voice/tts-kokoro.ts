import type { LoadProgress, SpeechSynthesizer } from '@greenroom/shared';
import { KokoroTTS } from 'kokoro-js';
import { detectCapabilities } from './capabilities.js';

/**
 * Kokoro-82M neural TTS, on-device.
 *
 * 82M parameters, which is what decides it. The binding constraint is not
 * voice quality but GPU memory: this model shares a tab with Whisper and a 1.7B
 * LLM, and a better-sounding voice that pushes the three past available VRAM
 * makes the product fail rather than merely sound worse. Total residency across
 * the three stages is the number to watch when changing any of them.
 *
 * Synthesis is not streaming: `generate()` returns a whole clip. That is fine
 * because the orchestrator already splits the LLM stream into sentences, so the
 * unit handed here is short and the first clip starts while the model is still
 * writing the rest of the turn.
 */
/**
 * Kokoro v1.0 ships English voices only (af_/am_ American, bf_/bm_ British).
 * There is no French voice, so French sessions route to the platform
 * synthesiser instead — see useSession.ts. Typing the voice against the
 * library's own voice map means a future French voice is a one-line change the
 * compiler checks, rather than a string that silently fails at runtime.
 */
export type KokoroVoice = keyof KokoroTTS['voices'] & string;

export interface KokoroOptions {
  model?: string;
  voice?: KokoroVoice;
}

const DEFAULT_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export class KokoroSynthesizer implements SpeechSynthesizer {
  readonly id: string;
  #tts?: KokoroTTS;
  #context?: AudioContext;
  #source?: AudioBufferSourceNode;
  #model: string;
  #voice: KokoroVoice;

  constructor(options: KokoroOptions = {}) {
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#voice = options.voice ?? 'af_heart';
    this.id = `kokoro:${this.#voice}`;
  }

  async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.#tts) return;
    const caps = await detectCapabilities();
    this.#tts = await KokoroTTS.from_pretrained(this.#model, {
      device: caps.hasWebGpu ? 'webgpu' : 'wasm',
      dtype: caps.hasWebGpu ? 'fp32' : 'q8',
      progress_callback: (info) => {
        // The union includes states with no `progress` field (initiate, done).
        const progress = 'progress' in info && typeof info.progress === 'number' ? info.progress : 0;
        onProgress?.({ stage: 'voice', progress: progress / 100 });
      },
    });
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    const tts = this.#tts;
    if (!tts) throw new Error('KokoroSynthesizer.load() must be awaited before speak()');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const result = await tts.generate(text, { voice: this.#voice });
    // Synthesis is not instant; the learner may have barged in while it ran.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Created lazily and reused: browsers cap concurrent AudioContexts, and a
    // per-utterance context leaks them over a long session.
    this.#context ??= new AudioContext();
    if (this.#context.state === 'suspended') await this.#context.resume();

    const samples = result.audio;
    const buffer = this.#context.createBuffer(1, samples.length, result.sampling_rate);
    // `set` rather than `copyToChannel`: the model's Float32Array may be backed
    // by a SharedArrayBuffer under cross-origin isolation, which copyToChannel
    // does not accept.
    buffer.getChannelData(0).set(samples);

    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    this.#source = source;

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.stop();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      source.onended = () => {
        signal?.removeEventListener('abort', onAbort);
        if (this.#source === source) this.#source = undefined;
        // `onended` fires for a stop() too; the abort listener has already
        // rejected in that case and this resolve is a no-op.
        resolve();
      };

      source.start();
    });
  }

  stop(): void {
    if (!this.#source) return;
    try {
      this.#source.stop();
    } catch {
      // Already stopped or never started. Nothing to do.
    }
    this.#source = undefined;
  }

  async unload(): Promise<void> {
    this.stop();
    await this.#context?.close();
    this.#context = undefined;
    this.#tts = undefined;
  }
}
