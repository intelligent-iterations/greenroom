import type {
  DuplexAudioChunk,
  DuplexCapabilities,
  DuplexEvent,
  DuplexLoadProgress,
  DuplexSessionOptions,
  DuplexVoiceStage,
} from '../duplex.js';
import { EventQueue } from '../queue.js';
import { DecoderCache } from './cache.js';
import { TextEmbeddings, generate } from './generate.js';
import { computeMel } from './mel.js';
import { istft } from './istft.js';
import { buildPrompt } from './tokens.js';
import {
  FRAME_DURATION_MS,
  HIDDEN_SIZE,
  INPUT_SAMPLE_RATE,
  NUM_CODEBOOKS,
  OUTPUT_SAMPLE_RATE,
} from './config.js';
import type { AssetSource, SessionLike, TensorFactory, TensorLike } from './runtime.js';

/**
 * LFM2.5-Audio as a duplex stage, running entirely in the browser.
 *
 * This is the piece that makes "realtime, on device" true rather than
 * aspirational: one model takes speech and produces speech, with no server and
 * no vendor. It is not literally full-duplex — the model generates a reply after
 * a turn rather than while listening, and the capabilities below say so rather
 * than implying otherwise.
 *
 * What it genuinely removes is the cascade: no separate recogniser, no separate
 * synthesiser, no text bottleneck between them. Prosody and content come from
 * one forward pass, which is the thing a three-model pipeline structurally
 * cannot do.
 */

export interface LfmStageOptions {
  assets: AssetSource;
  tensor: TensorFactory;
  /** Text to token ids. Supplied by the caller, which owns the tokenizer. */
  encode(text: string): number[] | Promise<number[]>;
  decode(tokens: number[]): string | Promise<string>;
  suffix?: string;
  systemPrompt?: string;
  audioTemperature?: number;
  audioTopK?: number;
  maxSteps?: number;
}

/**
 * Honest capabilities.
 *
 * `userTranscripts` is true because this model does its own recognition — the
 * text it emits before switching to audio is a transcript of what it heard, and
 * that is exactly what an evaluation needs.
 *
 * `nativeBargeIn` is false, and that is the important one. The model has no
 * concept of being interrupted mid-utterance; generation is a loop this code
 * owns. So barge-in belongs to the caller's voice activity detector, which must
 * abort the turn. Claiming otherwise would leave nobody handling it.
 */
export const LFM_CAPABILITIES: DuplexCapabilities = {
  userTranscripts: true,
  assistantTranscripts: true,
  transcriptsLeadAudio: true,
  nativeBargeIn: false,
};

const GRAPHS = [
  'audio_encoder',
  'decoder',
  'vocoder_depthformer',
  'audio_detokenizer',
  'audio_embedding',
] as const;

export class LfmAudioStage implements DuplexVoiceStage {
  readonly id = 'lfm2.5-audio';
  readonly capabilities = LFM_CAPABILITIES;

  #options: LfmStageOptions;
  #queue = new EventQueue<DuplexEvent>();
  #sessions = new Map<string, SessionLike>();
  #textEmbeddings?: TextEmbeddings;
  #cache?: DecoderCache;
  #pending: Float32Array[] = [];
  #turn?: AbortController;
  #open = false;
  #systemPrompt: string;

  constructor(options: LfmStageOptions) {
    this.#options = options;
    this.#systemPrompt = options.systemPrompt ?? 'Respond conversationally with audio.';
  }

  async load(onProgress?: (progress: DuplexLoadProgress) => void): Promise<void> {
    const suffix = this.#options.suffix ?? '_q4';
    this.#options.assets.onProgress?.((p) =>
      onProgress?.({
        file: p.file,
        loaded: p.loaded,
        ...(p.total !== undefined ? { total: p.total, fraction: p.loaded / p.total } : {}),
      }),
    );

    // Sequential rather than parallel: these are hundreds of megabytes each and
    // five concurrent GPU allocations is how a laptop runs out of memory
    // partway through and loses all of them.
    for (const graph of GRAPHS) {
      this.#sessions.set(graph, await this.#options.assets.session(`${graph}${suffix}`));
    }

    this.#textEmbeddings = new TextEmbeddings(await this.#options.assets.bytes('embed_tokens.bin'));
  }

  async open(options: DuplexSessionOptions = {}): Promise<void> {
    if (this.#sessions.size === 0) throw new Error('call load() before open()');
    if (options.systemPrompt) this.#systemPrompt = options.systemPrompt;
    this.#resetCache();
    this.#open = true;
  }

  #resetCache(): void {
    const decoder = this.#session('decoder');
    this.#cache = new DecoderCache(decoder, this.#options.tensor);
  }

  #session(name: string): SessionLike {
    const session = this.#sessions.get(name);
    if (!session) throw new Error(`session ${name} is not loaded`);
    return session;
  }

  /**
   * Buffer microphone audio.
   *
   * Accumulated rather than streamed upstream, because this model consumes a
   * complete utterance as a mel spectrogram. The caller's endpoint detector
   * decides when that utterance is over and calls `respond`.
   */
  send(chunk: DuplexAudioChunk): void {
    if (!this.#open) return;
    if (chunk.sampleRate !== INPUT_SAMPLE_RATE) {
      this.#queue.push({
        type: 'error',
        error: new Error(`expected ${INPUT_SAMPLE_RATE}Hz audio, got ${chunk.sampleRate}Hz`),
        at: performance.now(),
      });
      return;
    }
    this.#pending.push(chunk.samples);
  }

  /**
   * The turn is over: encode what was heard, then answer.
   *
   * Separate from `send` because a duplex interface has no natural place for
   * "the user stopped talking" — in a true duplex stream the vendor decides
   * that. Here the caller does, and pretending otherwise would hide it.
   */
  async respond(): Promise<void> {
    if (!this.#open || !this.#cache) return;

    const audio = concat(this.#pending);
    this.#pending = [];
    if (audio.length === 0) return;

    this.#turn?.abort();
    const turn = new AbortController();
    this.#turn = turn;

    const at = performance.now();
    this.#queue.push({ type: 'user_speech_stopped', at });

    try {
      const promptEmbeds = await this.#buildContext(audio);
      const textTokens: number[] = [];
      const frames: number[][] = [];

      await generate(
        {
          decoder: this.#session('decoder'),
          depthformer: this.#session('vocoder_depthformer'),
          audioEmbedding: this.#session('audio_embedding'),
        },
        this.#cache,
        promptEmbeds.data,
        promptEmbeds.length,
        this.#options.tensor,
        (token) => this.#textEmbeddings?.lookup([token]) ?? new Float32Array(HIDDEN_SIZE),
        {
          onText: (token) => {
            textTokens.push(token);
            void Promise.resolve(this.#options.decode([token])).then((text) => {
              this.#queue.push({
                type: 'assistant_transcript',
                text,
                final: false,
                at: performance.now(),
              });
            });
          },
          onAudioFrame: (codes) => {
            frames.push(codes);
            // Emitted in batches rather than per frame: one frame is 80ms and
            // decoding each alone would run the detokenizer 12 times a second
            // for no benefit. Every 4 frames is ~320ms, under the threshold
            // where a listener hears a gap.
            if (frames.length % 4 === 0) void this.#emitAudio(frames.splice(0, 4));
          },
        },
        {
          signal: turn.signal,
          ...(this.#options.audioTemperature !== undefined
            ? { audioTemperature: this.#options.audioTemperature }
            : {}),
          ...(this.#options.audioTopK !== undefined ? { audioTopK: this.#options.audioTopK } : {}),
          ...(this.#options.maxSteps !== undefined ? { maxSteps: this.#options.maxSteps } : {}),
        },
      );

      if (frames.length > 0) await this.#emitAudio(frames);

      if (turn.signal.aborted) {
        this.#queue.push({ type: 'assistant_interrupted', at: performance.now() });
      } else {
        this.#queue.push({ type: 'assistant_turn_complete', at: performance.now() });
      }
    } catch (error) {
      this.#queue.push({
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        at: performance.now(),
      });
    }
  }

  /** Mel, then the conformer encoder, then the prompt around it. */
  async #buildContext(audio: Float32Array): Promise<{ data: Float32Array; length: number }> {
    const mel = computeMel(audio);
    const encoded = await this.#session('audio_encoder').run({
      mel_spectrogram: this.#options.tensor('float32', mel.data, [1, mel.frames, mel.nMels]),
      mel_lengths: this.#options.tensor('int64', BigInt64Array.from([BigInt(mel.frames)]), [1]),
    });

    const audioEmbeds = encoded['audio_embeddings']?.data as Float32Array;
    const audioPositions = (encoded['audio_embeddings']?.dims[1] ?? 0) as number;

    const prompt = buildPrompt({ system: this.#systemPrompt });
    const ids = await this.#options.encode(prompt);
    const textEmbeds = this.#textEmbeddings?.lookup(ids) ?? new Float32Array(ids.length * HIDDEN_SIZE);

    // The encoded speech sits where the user's words would be, which is what
    // makes this end-to-end rather than a transcription pasted into a prompt.
    const total = ids.length + audioPositions;
    const data = new Float32Array(total * HIDDEN_SIZE);
    data.set(textEmbeds, 0);
    data.set(audioEmbeds.subarray(0, audioPositions * HIDDEN_SIZE), ids.length * HIDDEN_SIZE);

    return { data, length: total };
  }

  async #emitAudio(frames: number[][]): Promise<void> {
    if (frames.length === 0) return;
    const codes = new BigInt64Array(NUM_CODEBOOKS * frames.length);
    // The detokenizer wants [batch, codebook, time] — codebook-major. Writing
    // it frame-major produces audio that is confidently, unlistenably wrong.
    for (let c = 0; c < NUM_CODEBOOKS; c++) {
      for (let t = 0; t < frames.length; t++) {
        codes[c * frames.length + t] = BigInt(frames[t]?.[c] ?? 0);
      }
    }

    const out = await this.#session('audio_detokenizer').run({
      audio_codes: this.#options.tensor('int64', codes, [1, NUM_CODEBOOKS, frames.length]),
    });

    const features = out['stft_features']?.data as Float32Array;
    const stftFrames = (out['stft_features']?.dims[1] ?? 0) as number;
    const samples = istft(features, stftFrames);

    this.#queue.push({
      type: 'assistant_audio',
      chunk: { samples, sampleRate: OUTPUT_SAMPLE_RATE },
      at: performance.now(),
    });
  }

  events(): AsyncIterable<DuplexEvent> {
    return this.#queue;
  }

  /** Stop the current turn. The caller's VAD owns this; see LFM_CAPABILITIES. */
  interrupt(): void {
    this.#turn?.abort();
  }

  async close(): Promise<void> {
    this.#open = false;
    this.#turn?.abort();
    this.#queue.close();
  }

  async unload(): Promise<void> {
    for (const session of this.#sessions.values()) await session.release?.();
    this.#sessions.clear();
    this.#textEmbeddings = undefined;
  }

  /** Milliseconds of audio one generated frame represents. */
  static get frameDurationMs(): number {
    return FRAME_DURATION_MS;
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export type { TensorLike };
