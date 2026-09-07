import type { LoadProgress } from './pipeline.js';

/**
 * Duplex voice interfaces.
 *
 * A native realtime API (Gemini Live, Azure Realtime, OpenAI Realtime) collapses
 * STT + LLM + TTS into one bidirectional audio stream. It does not fit the
 * cascaded stage interfaces in pipeline.ts, and no amount of adapting makes it —
 * docs/adr/0002-cascaded-vs-realtime.md says so explicitly and is still right.
 *
 * So this is a SECOND, parallel seam rather than an extension of the first.
 * `SessionStages` stays a three-field struct. The only thing imported from
 * pipeline.ts is LoadProgress, which is a UI concern belonging to neither
 * architecture. The two orchestrators share `Turn` and `TurnTimings`, because
 * those are product requirements that outlive either.
 *
 * STATUS: nothing implements this against a live vendor. It has only ever run
 * against a scripted fake in unit tests. It is the shape the orchestration takes
 * and it is verified as a shape; it is not a working realtime integration, and
 * the README says exactly that.
 */

/** Audio the client sends upstream: mono PCM float32 in [-1,1]. */
export interface DuplexAudioChunk {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * One message from the vendor's stream.
 *
 * A closed union rather than a vendor payload. Every duplex vendor emits some
 * version of these under different names; anything that does not map onto them
 * is vendor-specific and belongs in that vendor's adapter, not here.
 *
 * `at` is stamped by the adapter on arrival in the `performance.now()` domain,
 * never taken from a vendor clock — the timings this produces have to be
 * comparable with the cascade's, and those are all local.
 */
export type DuplexEvent =
  | { type: 'user_speech_started'; at: number }
  | { type: 'user_speech_stopped'; at: number }
  | { type: 'user_transcript'; text: string; final: boolean; at: number }
  /**
   * What the assistant is saying. The field the product depends on: without it
   * there is no transcript, and so no debrief and no mastery scoring.
   */
  | { type: 'assistant_transcript'; text: string; final: boolean; at: number }
  | { type: 'assistant_audio'; chunk: DuplexAudioChunk; at: number }
  | { type: 'assistant_turn_complete'; at: number }
  /**
   * The service stopped its own output because the user interrupted.
   * `spokenText` is what actually reached the speaker, when the vendor knows it.
   * The transcript records what was HEARD rather than what was generated — the
   * same rule the cascade follows, for the same reason: otherwise the next turn
   * follows a thread the learner never heard.
   */
  | { type: 'assistant_interrupted'; spokenText?: string; at: number }
  | { type: 'error'; error: Error; at: number };

/**
 * What a given duplex vendor actually provides.
 *
 * Not decoration. Three of these decide whether the product's own requirements
 * survive the switch, and a session has to be able to refuse to start rather
 * than quietly produce a transcript that is not evidence of anything.
 */
export interface DuplexCapabilities {
  /** Emits `user_transcript`. Without it the mastery scorer has nothing to read. */
  userTranscripts: boolean;
  /** Emits `assistant_transcript`. Without it the debrief cannot quote anything. */
  assistantTranscripts: boolean;
  /**
   * Assistant transcript deltas arrive at or before the audio they describe.
   * When false, `firstTokenMs` is not measurable and is left undefined rather
   * than reported as a number that is really first-audio.
   */
  transcriptsLeadAudio: boolean;
  /**
   * Detects interruption server-side and stops its own audio. When true the
   * local VAD is not started at all and the barge-in guard does not apply.
   */
  nativeBargeIn: boolean;
}

export interface DuplexSessionOptions {
  /**
   * The compiled system prompt. Set once, at open.
   *
   * A duplex session cannot recompile per turn. That is a real capability loss
   * against the cascade, and the reason per-turn coverage steering and retrieved
   * grounding do not survive the switch — see the ADR 0002 amendment.
   */
  systemPrompt: string;
  /** Vendor voice id, where the vendor has named voices. */
  voice?: string;
  signal?: AbortSignal;
}

/**
 * A bidirectional speech-to-speech session with a vendor.
 *
 * Called a "stage" for symmetry with pipeline.ts, but it is not one: it replaces
 * three of them at once.
 */
export interface DuplexVoiceStage {
  readonly id: string;
  readonly capabilities: DuplexCapabilities;
  load(onProgress?: (p: LoadProgress) => void): Promise<void>;
  /** Opens the stream. Resolves when the socket can carry audio. */
  open(options: DuplexSessionOptions): Promise<void>;
  /** Pushes captured microphone audio upstream, continuously while open. */
  send(chunk: DuplexAudioChunk): void;
  /** Every event from the vendor, in arrival order. Ends when the stream closes. */
  events(): AsyncIterable<DuplexEvent>;
  /**
   * Ask the service to stop speaking now. Used only when `nativeBargeIn` is
   * false and the local VAD is doing the job instead.
   */
  interrupt(): void;
  close(): Promise<void>;
  unload?(): Promise<void>;
}
