/**
 * Pipeline interfaces.
 *
 * The voice loop is cascaded: VAD -> STT -> LLM -> TTS. Each stage is behind a
 * narrow interface so a stage can be swapped for a different vendor, or for a
 * deterministic fake in tests, without the orchestrator changing. The
 * orchestrator in packages/web/src/voice/session.ts depends only on this file.
 *
 * A native realtime API (Gemini Live, Azure Realtime, OpenAI Realtime) collapses
 * STT+LLM+TTS into one duplex stream and does not fit this shape. That is
 * deliberate — see docs/adr/0002-cascaded-vs-realtime.md for why the cascade is
 * the default here and what the realtime path would replace.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  /** Aborts generation mid-stream. Used for barge-in. */
  signal?: AbortSignal;
}

/** Progress during model download/compile. `loaded`/`total` are bytes when known. */
export interface LoadProgress {
  stage: string;
  progress: number; // 0..1
  loaded?: number;
  total?: number;
}

export interface LanguageModel {
  readonly id: string;
  load(onProgress?: (p: LoadProgress) => void): Promise<void>;
  /** Yields token deltas, not cumulative text. */
  generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<string>;
  /**
   * Optional. Pay one-off costs before the learner is waiting on them.
   *
   * On-device backends compile GPU shaders on their first generation, which can
   * take seconds — and it would land on the opening question, the first
   * impression the product makes. Warming up during the "getting ready" screen
   * moves that cost to where a delay is already expected.
   */
  warmUp?(systemPrompt: string): Promise<void>;
  unload?(): Promise<void>;
}

export interface TranscriptionResult {
  text: string;
  /** Mean token logprob mapped to 0..1 where the backend exposes it. */
  confidence?: number;
  language?: string;
}

export interface SpeechRecognizer {
  readonly id: string;
  load(onProgress?: (p: LoadProgress) => void): Promise<void>;
  /** `audio` is mono PCM float32 in [-1,1]. */
  transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptionResult>;
  unload?(): Promise<void>;
}

export interface SpeechSynthesizer {
  readonly id: string;
  load(onProgress?: (p: LoadProgress) => void): Promise<void>;
  /**
   * Speaks `text` and resolves when playback finishes. Must reject with an
   * AbortError promptly when `signal` aborts — barge-in responsiveness is
   * dominated by how fast this stops, not by how fast the LLM stops.
   */
  speak(text: string, signal?: AbortSignal): Promise<void>;
  /** Stops playback immediately and discards anything queued. */
  stop(): void;
  unload?(): Promise<void>;
}

/**
 * Per-turn latency instrumentation.
 *
 * All values are ms measured from `speechEndedAt`, the moment VAD declared the
 * learner finished speaking. That anchor matters: measuring from mic-open makes
 * a slow talker look like a slow system, and the number the learner actually
 * feels is the gap after they stop.
 */
export interface TurnTimings {
  speechEndedAt: number;
  /** VAD close -> transcript in hand. */
  sttMs?: number;
  /** VAD close -> first LLM token. */
  firstTokenMs?: number;
  /** VAD close -> first audible sample. The number that governs perceived lag. */
  firstAudioMs?: number;
  /** VAD close -> interviewer finished speaking. */
  turnaroundMs?: number;
  /** Set when the learner interrupted playback. */
  bargedIn?: boolean;
}

/**
 * Target budget for the cascade, in ms from VAD close to first audio.
 *
 * These are design targets, chosen from the gap length that human conversation
 * tolerates before a pause reads as a breakdown: a few hundred milliseconds
 * passes unnoticed, and something over a second invites the other party to
 * start talking again. They are the thresholds the UI colours against and the
 * numbers docs/BENCHMARKS.md measures, so they are stated here as the budget
 * the pipeline is held to rather than as an observation about this build.
 */
export const LATENCY_BUDGET = {
  firstAudioGoodMs: 800,
  firstAudioAcceptableMs: 1500,
} as const;

/**
 * Strips reasoning blocks out of a token stream.
 *
 * Small instruct models in this size class are increasingly reasoning-capable,
 * and a reasoning block reaching this pipeline is not a cosmetic problem: the
 * synthesiser would read the model's private deliberation aloud to the learner,
 * in the interviewer's voice. That is the worst output this product can
 * produce, so it is filtered rather than trusted away.
 *
 * The adapter also asks the backend to disable thinking. This is the second
 * line of defence, because that request is per-vendor, silently ignored by
 * models that do not support it, and one model swap away from not applying.
 *
 * Stateful because tags routinely straddle delta boundaries — `<thi` arrives in
 * one chunk and `nk>` in the next, and a stateless regex would emit the halves.
 */
const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/** Longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagTail(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (tag.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

export class ThinkingStripper {
  #buffer = '';
  #inside = false;

  /** Feeds a delta and returns the text that is safe to speak. */
  push(delta: string): string {
    this.#buffer += delta;
    let out = '';

    while (this.#buffer.length > 0) {
      if (this.#inside) {
        const close = this.#buffer.indexOf(CLOSE_TAG);
        if (close === -1) {
          // Keep only what might be the start of a closing tag; the rest is
          // reasoning and is discarded.
          const keep = partialTagTail(this.#buffer, CLOSE_TAG);
          this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
          return out;
        }
        this.#buffer = this.#buffer.slice(close + CLOSE_TAG.length);
        this.#inside = false;
        continue;
      }

      const open = this.#buffer.indexOf(OPEN_TAG);
      if (open === -1) {
        const keep = partialTagTail(this.#buffer, OPEN_TAG);
        out += this.#buffer.slice(0, this.#buffer.length - keep);
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        return out;
      }

      out += this.#buffer.slice(0, open);
      this.#buffer = this.#buffer.slice(open + OPEN_TAG.length);
      this.#inside = true;
    }

    return out;
  }

  /**
   * Returns any text held back at end of stream.
   *
   * An unterminated reasoning block yields nothing: if the model opened
   * `<think>` and never closed it, everything after it is deliberation and
   * speaking it would be exactly the failure this class exists to prevent.
   */
  flush(): string {
    if (this.#inside) {
      this.#buffer = '';
      return '';
    }
    const remainder = this.#buffer;
    this.#buffer = '';
    return remainder;
  }

  get insideReasoningBlock(): boolean {
    return this.#inside;
  }
}

/** Below this, a "sentence" is a fragment that sounds clipped spoken alone. */
const MIN_SENTENCE_CHARS = 12;

/**
 * Clause fragments need more length than sentences before they are worth
 * speaking: a sentence ends on a natural cadence, a clause does not, so a short
 * one sounds like the voice was cut off rather than like it paused.
 */
const MIN_CLAUSE_CHARS = 25;

export interface ChunkOptions {
  /**
   * Allow the next chunk to break at a clause boundary rather than waiting for
   * a full sentence. Set only while a turn has produced no audio yet.
   */
  allowClauseBreak?: boolean;
}

/**
 * Split streaming text into speakable chunks at sentence boundaries.
 *
 * TTS cannot start until it has a syntactically complete unit, but waiting for
 * the full LLM response costs a second or more of dead air. Emitting per
 * sentence lets audio start while the model is still generating, which is the
 * single largest win available in a cascaded pipeline.
 *
 * Returns [chunks, remainder]: the caller keeps the remainder as the new buffer
 * and flushes it when the stream ends.
 */
export function splitSpeakableChunks(
  buffer: string,
  options: ChunkOptions = {},
): [string[], string] {
  const chunks: string[] = [];
  // Sentence end = terminal punctuation followed by whitespace. Requiring the
  // whitespace avoids splitting inside "3.5" or "Ph.D." mid-stream.
  const boundary = /([.!?…]+)\s+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(buffer)) !== null) {
    const end = match.index + match[0].length;
    const candidate = buffer.slice(lastIndex, end).trim();
    // Very short fragments ("Yes.") are real sentences but make choppy audio
    // when spoken alone, so hold them and let them merge with what follows.
    if (candidate.length >= MIN_SENTENCE_CHARS) {
      chunks.push(candidate);
      lastIndex = end;
    }
  }

  // Nothing complete yet, and this turn has not made a sound. Falling back to a
  // clause boundary starts audio a whole sentence earlier, which is the
  // difference between a reply that feels immediate and one that feels
  // considered. Only ever used to get the first chunk out: once audio is
  // playing, waiting for full sentences gives better prosody, and the caller
  // stops passing the flag.
  if (chunks.length === 0 && options.allowClauseBreak) {
    const clause = /[,;:—–]\s+/g;
    let candidate: RegExpExecArray | null;
    while ((candidate = clause.exec(buffer)) !== null) {
      const end = candidate.index + candidate[0].length;
      const text = buffer.slice(0, end).trim();
      if (text.length >= MIN_CLAUSE_CHARS) {
        return [[text], buffer.slice(end)];
      }
    }
  }

  return [chunks, buffer.slice(lastIndex)];
}
