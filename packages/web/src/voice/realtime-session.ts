import type {
  DuplexAudioChunk,
  DuplexEvent,
  DuplexVoiceStage,
  InterviewScenario,
  LearnerState,
  Turn,
  TurnTimings,
  VoicePreset,
} from '@greenroom/shared';
import { logEvent } from './diagnostics.js';
import { Emitter } from './emitter.js';
import { BARGE_IN_GUARD_MS, type SessionEvents, type SessionState } from './session.js';
import type { VadController } from './vad.types.js';

/**
 * The duplex orchestrator.
 *
 * A parallel class to InterviewSession, not a variant of it. ADR 0002 predicted
 * that a realtime path would replace the orchestrator rather than reconfigure
 * it, and this is that prediction carried out: pipeline.ts, SessionStages and
 * routing.ts are untouched.
 *
 * What it shares with the cascade is what the *product* requires regardless of
 * architecture — the same event surface, the same SessionState, the same Turn
 * and TurnTimings, and the same barge-in guard constant. Those are the parts a
 * debrief, a mastery score and a latency table are made of.
 *
 * STATUS: no adapter implements DuplexVoiceStage against a live vendor. Every
 * test below runs against ScriptedDuplexTransport. The orchestration is
 * verified; the vendor path does not exist.
 */
export interface RealtimeSessionConfig {
  preset?: VoicePreset;
  scenario: InterviewScenario;
  learner: LearnerState;
  stage: DuplexVoiceStage;
  /** Compiled system prompt. Set once at open; a duplex session cannot recompile. */
  systemPrompt: string;
  /** Injectable for tests; only constructed when the vendor lacks native barge-in. */
  vad?: VadController;
}

export class RealtimeSession extends Emitter<SessionEvents> {
  readonly scenario: InterviewScenario;
  #stage: DuplexVoiceStage;
  #systemPrompt: string;
  #vad?: VadController;
  #state: SessionState = 'idle';
  #turns: Turn[] = [];

  /** Accumulated text for the turn currently being spoken by each side. */
  #userText = '';
  #assistantText = '';
  #timings?: TurnTimings;
  #playbackStartedAt?: number;
  #pump?: Promise<void>;

  constructor(config: RealtimeSessionConfig) {
    super();
    this.scenario = config.scenario;
    this.#stage = config.stage;
    this.#systemPrompt = config.systemPrompt;
    // Exactly one owner of interruption. A vendor that stops its own audio and
    // a local VAD calling interrupt() would race, and the guard window exists
    // for an echo problem the vendor is already solving.
    if (!config.stage.capabilities.nativeBargeIn && config.vad) this.#vad = config.vad;
  }

  get state(): SessionState {
    return this.#state;
  }

  get turns(): Turn[] {
    return this.#turns;
  }

  async start(): Promise<void> {
    // Refuse rather than run degraded. A session with no interviewer transcript
    // cannot produce a debrief or a mastery score, and those are product
    // requirements rather than features — better to say so at open than to
    // discover it when the debrief is empty.
    if (!this.#stage.capabilities.assistantTranscripts) {
      const error = new Error(
        `${this.#stage.id} emits no assistant transcript, so this session could not produce a debrief or a score`,
      );
      this.#fail(error);
      throw error;
    }

    this.#setState('loading');
    await this.#stage.load((p) => this.emit('progress', p));
    await this.#stage.open({ systemPrompt: this.#systemPrompt });

    // onSpeechEnd is unused on this path: the vendor decides when the learner
    // has stopped, and a second opinion from a local VAD would only disagree.
    await this.#vad?.start({
      onSpeechStart: () => this.#handleLocalSpeechStart(),
      onSpeechEnd: () => {},
    });

    this.#setState('listening');
    this.#pump = this.#consume();
  }

  /** Pushes captured audio upstream. Called by whatever owns the microphone. */
  send(chunk: DuplexAudioChunk): void {
    this.#stage.send(chunk);
  }

  async end(): Promise<void> {
    await this.#vad?.destroy();
    await this.#stage.close();
    await this.#pump;
    this.#setState('ended');
  }

  /**
   * Local barge-in, for vendors that do not do it themselves.
   *
   * Deliberately the same guard window as the cascade, imported rather than
   * copied: two guard constants that drift is how the one nobody is looking at
   * becomes the one in production.
   */
  #handleLocalSpeechStart(): void {
    if (this.#state !== 'speaking') return;
    const sincePlayback = performance.now() - (this.#playbackStartedAt ?? 0);
    if (sincePlayback < BARGE_IN_GUARD_MS) {
      logEvent('realtime.speechStart.withinGuard', { sincePlaybackMs: sincePlayback });
      return;
    }
    logEvent('realtime.bargeIn', { sincePlaybackMs: sincePlayback });
    this.#stage.interrupt();
  }

  async #consume(): Promise<void> {
    try {
      for await (const event of this.#stage.events()) this.#handle(event);
    } catch (err) {
      this.#fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #handle(event: DuplexEvent): void {
    switch (event.type) {
      case 'user_speech_started':
        this.#setState('listening');
        return;

      case 'user_speech_stopped':
        // Every timing anchors here, exactly as the cascade anchors on VAD
        // close — which is what lets both architectures land in one latency
        // table rather than two that cannot be compared.
        this.#timings = { speechEndedAt: event.at };
        this.#setState('thinking');
        return;

      case 'user_transcript':
        this.#userText = event.text;
        return;

      case 'assistant_transcript':
        this.#commitUserTurn();
        if (this.#timings && this.#timings.firstTokenMs === undefined) {
          // Only meaningful when the vendor's text genuinely leads its audio.
          // Reporting first-audio under this name would be a measurement of the
          // wrong thing that looks like a measurement of the right one.
          if (this.#stage.capabilities.transcriptsLeadAudio) {
            this.#timings.firstTokenMs = event.at - this.#timings.speechEndedAt;
          }
        }
        this.#assistantText = event.text;
        this.emit('interviewerDelta', event.text);
        return;

      case 'assistant_audio':
        this.#commitUserTurn();
        if (this.#timings && this.#timings.firstAudioMs === undefined) {
          this.#timings.firstAudioMs = event.at - this.#timings.speechEndedAt;
        }
        if (this.#playbackStartedAt === undefined) this.#playbackStartedAt = event.at;
        this.#setState('speaking');
        return;

      case 'assistant_turn_complete':
        this.#commitAssistantTurn(this.#assistantText, event.at, false);
        return;

      case 'assistant_interrupted':
        // What was heard, not what was generated.
        this.#commitAssistantTurn(event.spokenText ?? this.#assistantText, event.at, true);
        return;

      case 'error':
        this.#fail(event.error);
        return;
    }
  }

  /**
   * Commit the learner's turn when the interviewer starts answering it.
   *
   * Duplex transcripts get revised, so there is a choice here and both options
   * cost something. Waiting for `final` would let the interviewer's turn land
   * first and reorder the transcript. Committing on the first assistant event
   * costs a late revision instead, which is logged. Ordering is worth more: the
   * transcript is read as evidence, and evidence out of order is worse than
   * evidence slightly out of date.
   */
  #commitUserTurn(): void {
    if (this.#userText.length === 0) return;
    this.#pushTurn('learner', this.#userText, this.#timings?.speechEndedAt ?? performance.now());
    this.#userText = '';
  }

  #commitAssistantTurn(text: string, at: number, bargedIn: boolean): void {
    if (text.length > 0) {
      this.#pushTurn('interviewer', text, at, bargedIn);
    }
    if (this.#timings) {
      this.#timings.turnaroundMs = at - this.#timings.speechEndedAt;
      if (bargedIn) this.#timings.bargedIn = true;
      // sttMs is never set. A duplex stream has no recognition boundary to
      // measure, which is ADR 0002's "a duplex stream says the turn was slow"
      // showing up as a blank in the HUD. Do not fill it in with a zero.
      this.emit('timings', this.#timings);
      this.#timings = undefined;
    }
    this.#assistantText = '';
    this.#playbackStartedAt = undefined;
    this.#setState('listening');
  }

  #pushTurn(role: Turn['role'], text: string, startedAt: number, bargedIn = false): void {
    const turn: Turn = {
      id: crypto.randomUUID(),
      role,
      text,
      startedAt,
      ...(bargedIn ? { bargedIn: true } : {}),
    };
    this.#turns.push(turn);
    this.emit('turn', turn);
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', state);
  }

  #fail(error: Error): void {
    logEvent('realtime.error', { message: error.message });
    this.#setState('error');
    this.emit('error', error);
    void this.#vad?.destroy();
  }
}
