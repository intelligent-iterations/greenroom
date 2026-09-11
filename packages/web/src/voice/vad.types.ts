/**
 * VAD contract, kept apart from the implementation.
 *
 * `vad.ts` pulls in onnxruntime-web and the Silero weights at import time. The
 * orchestrator needs only these types, so splitting them keeps that ~2MB out of
 * the initial bundle and out of headless test import graphs.
 */
export interface VadHandlers {
  onSpeechStart: () => void;
  /** `audio` is mono float32 PCM at 16kHz, with pre-speech padding included. */
  onSpeechEnd: (audio: Float32Array) => void;
  /** Speech too short to be real — a cough, a door. Never starts a turn. */
  onMisfire?: () => void;
  /**
   * Speech probability has just dropped — the learner may have finished, and
   * the redemption countdown has begun.
   *
   * Fires up to `redemptionMs` before `onSpeechEnd`, carrying the speech
   * captured so far. It is a *guess*: the learner may simply be drawing breath,
   * in which case `onSpeechResumed` follows and this should be discarded. Its
   * purpose is to let transcription start during the endpoint wait instead of
   * after it — see speculative-stt.ts.
   */
  onSilenceOnset?: (audio: Float32Array) => void;
  /** Speech came back before the endpoint confirmed. Any guess is now void. */
  onSpeechResumed?: () => void;
}

/**
 * The surface the orchestrator depends on. Extracted so a session can be driven
 * by a scripted fake in tests — the voice loop's concurrency (barge-in, queue
 * ordering, abort propagation) is exactly the part that most needs tests and is
 * impossible to exercise against a real microphone.
 */
export interface VadController {
  start(handlers: VadHandlers, options?: VadOptions): Promise<void>;
  pause(): void;
  resume(): void;
  destroy(): Promise<void>;
  readonly running: boolean;
}

export interface VadOptions {
  /** Silence tolerated, in ms, before the turn is considered finished. */
  redemptionMs?: number;
  /** Minimum speech duration, in ms, for a segment to count as a turn. */
  minSpeechMs?: number;
}

