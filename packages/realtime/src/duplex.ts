/**
 * A vendor-neutral full-duplex voice session.
 *
 * A realtime API — Moshi, Gemini Live, OpenAI Realtime, Azure Realtime —
 * collapses speech recognition, the language model and speech synthesis into a
 * single bidirectional audio stream. It is not a faster cascade; it is a
 * different shape, and pretending otherwise is how adapters end up lying about
 * what they can measure.
 *
 * Two things this interface insists on, because they are what a duplex stream
 * silently takes away:
 *
 *  - **Transcripts are a capability, not a given.** Without them there is no
 *    record of what was said, so no evaluation, no debrief, no scoring. A
 *    session is allowed to refuse to start rather than produce a recording that
 *    is not evidence of anything.
 *  - **The system prompt is set once, at open.** A duplex session cannot
 *    recompile per turn, so per-turn steering and retrieved grounding do not
 *    survive the switch from a cascade. That is a real capability loss and it
 *    belongs in the type, where someone porting will see it.
 */

/** Audio sent upstream: mono PCM float32 in [-1, 1]. */
export interface DuplexAudioChunk {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * One message from the vendor's stream.
 *
 * A closed union rather than a vendor payload. Every duplex vendor emits some
 * version of these under different names; anything that does not map onto them
 * is vendor-specific and belongs in that vendor's adapter.
 *
 * `at` is stamped by the adapter on arrival, in the local clock, never taken
 * from a vendor timestamp — latency figures have to be comparable across
 * vendors and against a cascade, and those are all measured locally.
 */
export type DuplexEvent =
  | { type: 'user_speech_started'; at: number }
  | { type: 'user_speech_stopped'; at: number }
  | { type: 'user_transcript'; text: string; final: boolean; at: number }
  | { type: 'assistant_transcript'; text: string; final: boolean; at: number }
  | { type: 'assistant_audio'; chunk: DuplexAudioChunk; at: number }
  | { type: 'assistant_turn_complete'; at: number }
  /**
   * The service stopped its own output because the user interrupted.
   * `spokenText` is what actually reached the speaker, where the vendor knows
   * it: the record should reflect what was *heard*, not what was generated, or
   * the next turn follows a thread the user never received.
   */
  | { type: 'assistant_interrupted'; spokenText?: string; at: number }
  | { type: 'error'; error: Error; at: number };

export interface DuplexCapabilities {
  /** Emits `user_transcript`. Without it there is no record of what was said. */
  userTranscripts: boolean;
  /** Emits `assistant_transcript`. Without it nothing can quote the agent. */
  assistantTranscripts: boolean;
  /**
   * Transcript deltas arrive at or before the audio they describe. When false,
   * time-to-first-token is not measurable and should be left undefined rather
   * than reported as a number that is really time-to-first-audio.
   */
  transcriptsLeadAudio: boolean;
  /**
   * The service detects interruption itself and stops its own audio. When true,
   * a local voice activity detector must not also be driving barge-in: two
   * owners of one behaviour is how a session ends up interrupting itself.
   */
  nativeBargeIn: boolean;
}

export interface DuplexSessionOptions {
  /** The system prompt. Set once, at open; see the note above. */
  systemPrompt?: string;
  /** Vendor voice id, where the vendor has named voices. */
  voice?: string;
  signal?: AbortSignal;
}

/** Progress while a stage fetches whatever it needs before it can open. */
export interface DuplexLoadProgress {
  /** 0–1, or undefined where the source reports no total. */
  fraction?: number;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface DuplexVoiceStage {
  readonly id: string;
  readonly capabilities: DuplexCapabilities;
  /**
   * Fetch or warm anything needed before `open`.
   *
   * Optional because a server-backed stage has nothing to load — the weights
   * are already on the machine running the model. A stage that one day runs a
   * duplex model locally would report a download here.
   */
  load?(onProgress?: (progress: DuplexLoadProgress) => void): Promise<void>;
  /** Opens the stream. Resolves when it can carry audio. */
  open(options?: DuplexSessionOptions): Promise<void>;
  /** Pushes captured microphone audio upstream, continuously while open. */
  send(chunk: DuplexAudioChunk): void;
  /** Every event from the vendor, in arrival order. Ends when the stream closes. */
  events(): AsyncIterable<DuplexEvent>;
  /** Ask the service to stop speaking now. */
  interrupt(): void;
  close(): Promise<void>;
  /** Release anything `load` acquired. */
  unload?(): Promise<void>;
}
