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
export function splitSpeakableChunks(buffer: string): [string[], string] {
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
    if (candidate.length >= 12) {
      chunks.push(candidate);
      lastIndex = end;
    }
  }

  return [chunks, buffer.slice(lastIndex)];
}
