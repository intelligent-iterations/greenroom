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
  INTERLEAVED_SYSTEM_PROMPT,
  TTS_SYSTEM_PROMPT,
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
  /**
   * Text sampling temperature.
   *
   * Defaults to a little above zero rather than to greedy. Pure argmax on this
   * model degenerates: after a perfectly good opening line it falls into
   * repeating encyclopedia fragments until the step limit, which is both
   * useless and the slowest possible way to produce nothing. There was no way
   * to set this at all before — `generate()` accepted it and nothing passed it.
   */
  textTemperature?: number;
  audioTemperature?: number;
  audioTopK?: number;
  maxSteps?: number;
  /** Injectable randomness, so a sampled turn can be reproduced in a test. */
  random?: () => number;
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

/**
 * The longest utterance kept before the oldest audio is dropped.
 *
 * Generous for speech — nobody says one sentence for half a minute — and small
 * enough that a forgotten open microphone cannot grow a buffer until the tab
 * dies.
 */
const MAX_PENDING_SAMPLES = INPUT_SAMPLE_RATE * 30;

/**
 * Release the event loop.
 *
 * A macrotask, deliberately — `await Promise.resolve()` drains microtasks and
 * the browser still never paints. This is what keeps the tab usable while a
 * reply generates, and what lets already-generated audio actually start
 * playing instead of queueing up behind the rest of the turn.
 */
const releaseEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

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
  #pendingSamples = 0;
  #turn?: AbortController;
  /** The turn currently generating, if any. See respond(). */
  #active?: Promise<void>;
  #open = false;
  #systemPrompt: string;

  constructor(options: LfmStageOptions) {
    this.#options = options;
    this.#systemPrompt = options.systemPrompt ?? INTERLEAVED_SYSTEM_PROMPT;
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
    this.#pendingSamples += chunk.samples.length;
    // A microphone that is never endpointed would otherwise buffer without
    // limit. The model takes an utterance, not a recording of the afternoon,
    // so the oldest audio goes first.
    while (this.#pendingSamples > MAX_PENDING_SAMPLES && this.#pending.length > 1) {
      this.#pendingSamples -= this.#pending.shift()!.length;
    }
  }

  /**
   * The turn is over: encode what was heard, then answer.
   *
   * Separate from `send` because a duplex interface has no natural place for
   * "the user stopped talking" — in a true duplex stream the vendor decides
   * that. Here the caller does, and pretending otherwise would hide it.
   */
  async respond(): Promise<void> {
    if (!this.#open) return;

    // One turn at a time, and the wait is the whole point.
    //
    // Generation is autoregressive over a single mutable DecoderCache. Two
    // turns running at once interleave their writes into it, so the second
    // one is decoding against a cache the first is still advancing — and both
    // hold a full set of intermediate tensors. Observed as
    // `RuntimeError: memory access out of bounds` a few seconds into the first
    // conversation, because an endpoint detector that fires every five seconds
    // will happily start a second turn while the first is still speaking.
    //
    // Aborting without awaiting is not enough: abort only asks, and the loop
    // finishes its current step. So the new turn waits for the old one to
    // actually stop before touching the cache.
    const previous = this.#active;
    this.#turn?.abort();
    if (previous) await previous.catch(() => {});
    if (!this.#open || !this.#cache) return;

    const run = this.#runTurn(this.#cache);
    this.#active = run;
    try {
      await run;
    } finally {
      if (this.#active === run) this.#active = undefined;
    }
  }

  /** True while a turn is generating. */
  get busy(): boolean {
    return this.#active !== undefined;
  }

  async #runTurn(cache: DecoderCache): Promise<void> {
    const audio = concat(this.#pending);
    this.#pending = [];
    this.#pendingSamples = 0;
    if (audio.length === 0) return;

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
        cache,
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
          onDone: (summary) => this.#reportTurn(summary),
        },
        {
          signal: turn.signal,
          yield: releaseEventLoop,
          ...(this.#options.textTemperature !== undefined
            ? { textTemperature: this.#options.textTemperature }
            : {}),
          ...(this.#options.random ? { random: this.#options.random } : {}),
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

    // The encoded speech sits where the user's words would be, which is what
    // makes this end-to-end rather than a transcription pasted into a prompt —
    // and it has to be *between* the halves, not after them. See buildPrompt.
    const { prefix, suffix } = buildPrompt({ system: this.#systemPrompt });
    const prefixIds = await this.#options.encode(prefix);
    const suffixIds = await this.#options.encode(suffix);
    const lookup = (ids: number[]): Float32Array =>
      this.#textEmbeddings?.lookup(ids) ?? new Float32Array(ids.length * HIDDEN_SIZE);

    const total = prefixIds.length + audioPositions + suffixIds.length;
    const data = new Float32Array(total * HIDDEN_SIZE);
    data.set(lookup(prefixIds), 0);
    data.set(
      audioEmbeds.subarray(0, audioPositions * HIDDEN_SIZE),
      prefixIds.length * HIDDEN_SIZE,
    );
    data.set(lookup(suffixIds), (prefixIds.length + audioPositions) * HIDDEN_SIZE);

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

  /**
   * Speak a line of text, using the same weights.
   *
   * The model's TTS mode, which the reference drives with its own system
   * instruction and a text user turn — no audio in, audio out. It shares every
   * session and the whole audio path with `respond()`, so it is also the
   * shortest way to find out whether this pipeline can make a sound at all
   * without needing a microphone or a person.
   *
   * Serialised against a conversational turn for the same reason those are
   * serialised against each other: one DecoderCache.
   */
  async speak(text: string, options: { voice?: string; maxSteps?: number } = {}): Promise<void> {
    if (!this.#open) return;
    const previous = this.#active;
    this.#turn?.abort();
    if (previous) await previous.catch(() => {});
    if (!this.#open || !this.#cache) return;

    const run = this.#runSpeech(text, options.voice ?? TTS_SYSTEM_PROMPT, options.maxSteps);
    this.#active = run;
    try {
      await run;
    } finally {
      if (this.#active === run) this.#active = undefined;
    }
  }

  async #runSpeech(text: string, system: string, maxSteps?: number): Promise<void> {
    const turn = new AbortController();
    this.#turn = turn;
    // A fresh cache: this is a new conversation turn, not a continuation.
    this.#resetCache();

    try {
      const { prefix, suffix } = buildPrompt({ system, user: text });
      const ids = [
        ...(await this.#options.encode(prefix)),
        ...(await this.#options.encode(suffix)),
      ];
      const embeds =
        this.#textEmbeddings?.lookup(ids) ?? new Float32Array(ids.length * HIDDEN_SIZE);

      const frames: number[][] = [];
      await generate(
        {
          decoder: this.#session('decoder'),
          depthformer: this.#session('vocoder_depthformer'),
          audioEmbedding: this.#session('audio_embedding'),
        },
        this.#cache as DecoderCache,
        embeds,
        ids.length,
        this.#options.tensor,
        (token) => this.#textEmbeddings?.lookup([token]) ?? new Float32Array(HIDDEN_SIZE),
        {
          // A TTS turn should emit almost no text before switching to audio.
          // What it emits instead is the evidence for why it did not.
          onText: (token) => {
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
            if (frames.length % 4 === 0) void this.#emitAudio(frames.splice(0, 4));
          },
          onDone: (summary) => this.#reportTurn(summary),
        },
        {
          signal: turn.signal,
          yield: releaseEventLoop,
          textTemperature: 0.7,
          audioTemperature: 0.7,
          ...(maxSteps !== undefined ? { maxSteps } : {}),
        },
      );

      if (frames.length > 0) await this.#emitAudio(frames);
      this.#queue.push({ type: 'assistant_turn_complete', at: performance.now() });
    } catch (error) {
      this.#queue.push({
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        at: performance.now(),
      });
    }
  }

  /**
   * Say why a turn produced no sound, when it produced none.
   *
   * Silence with no explanation is what made this expensive to chase: the
   * model answering in text forever and the audio path throwing on its first
   * frame look identical from outside.
   */
  #reportTurn(summary: { steps: number; frames: number; reachedAudio: boolean }): void {
    if (summary.frames > 0) return;
    const reason = summary.reachedAudio
      ? 'the model switched to audio but produced no frames'
      : 'the model answered in text and never switched to audio';
    console.debug(`[lfm] turn produced no audio after ${summary.steps} steps: ${reason}`);
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
    // Awaited, so a caller that closes and then unloads cannot release the
    // sessions out from under a turn that is still running on them.
    await this.#active?.catch(() => {});
    this.#pending = [];
    this.#pendingSamples = 0;
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
