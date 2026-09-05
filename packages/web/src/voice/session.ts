import {
  compileCoachPrompt,
  compileInterviewerPrompt,
  splitSpeakableChunks,
  type ChatMessage,
  type CompiledPrompt,
  type InterviewScenario,
  type LanguageModel,
  type LearnerState,
  type LoadProgress,
  type SpeechRecognizer,
  type SpeechSynthesizer,
  type Turn,
  type TurnTimings,
} from '@greenroom/shared';
import { Emitter } from './emitter.js';
import type { VadController } from './vad.types.js';

export type SessionState =
  | 'idle'
  | 'loading'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'ended'
  | 'error';

interface SessionEvents extends Record<string, (...args: never[]) => void> {
  state: (state: SessionState) => void;
  /** Streaming text for the live caption. Cumulative for the current turn. */
  interviewerDelta: (text: string) => void;
  turn: (turn: Turn) => void;
  timings: (timings: TurnTimings) => void;
  progress: (progress: LoadProgress) => void;
  error: (error: Error) => void;
}

export interface SessionStages {
  recognizer: SpeechRecognizer;
  model: LanguageModel;
  synthesizer: SpeechSynthesizer;
}

export interface SessionConfig {
  scenario: InterviewScenario;
  learner: LearnerState;
  stages: SessionStages;
  /** Injectable for tests; defaults to the real microphone-backed detector. */
  vad?: VadController;
}

/**
 * How long after audio playback begins we refuse to treat detected speech as a
 * barge-in.
 *
 * Browser echo cancellation needs a moment to converge on a newly started
 * output signal, and during that window the interviewer's own first syllable
 * can leak into the mic. Without a guard the session can livelock, every turn
 * barging in on itself before it finishes a word.
 *
 * The value trades self-interruption against ignoring a genuinely impatient
 * learner. 400ms is the starting point; it is a named constant rather than a
 * literal in the handler so it can be tuned against real devices, which is
 * where AEC behaviour actually varies.
 */
const BARGE_IN_GUARD_MS = 400;

/**
 * Orchestrates one spoken interview.
 *
 * Owns the cascade — VAD -> STT -> LLM -> TTS — and the two things that make a
 * cascade feel live rather than like a walkie-talkie:
 *
 *  - **Sentence-level handoff.** TTS starts on the first complete sentence
 *    instead of the full response, which is what keeps first-audio inside the
 *    budget even though the LLM is still generating.
 *  - **Barge-in.** Detected speech during playback aborts the LLM stream and
 *    stops audio in the same tick. Being interruptible is most of what makes a
 *    voice agent feel like a conversation.
 *
 * Depends only on the interfaces in @greenroom/shared, so every stage can be
 * replaced with another vendor or a deterministic fake.
 */
export class InterviewSession extends Emitter<SessionEvents> {
  readonly scenario: InterviewScenario;
  readonly prompt: CompiledPrompt;

  #stages: SessionStages;
  #learner: LearnerState;
  #vad?: VadController;
  #state: SessionState = 'idle';
  #turns: Turn[] = [];
  #interviewerTurnCount = 0;

  /** Aborts the in-flight interviewer turn. Replaced each turn. */
  #turnAbort?: AbortController;
  /** Serialises TTS so sentences play in order. */
  #speakQueue: Promise<void> = Promise.resolve();
  /** performance.now() when the current playback began. Guards barge-in. */
  #playbackStartedAt = 0;
  #timings?: TurnTimings;

  constructor(config: SessionConfig) {
    super();
    this.scenario = config.scenario;
    this.#stages = config.stages;
    this.#learner = config.learner;
    if (config.vad) this.#vad = config.vad;
    this.prompt = compileInterviewerPrompt({ scenario: config.scenario, learner: config.learner });
  }

  get state(): SessionState {
    return this.#state;
  }

  get turns(): readonly Turn[] {
    return this.#turns;
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit('state', state);
  }

  /** Loads all three stages, opens the mic, and delivers the opening question. */
  async start(): Promise<void> {
    this.#setState('loading');
    try {
      // Loaded together: three sequential model downloads is a minute of dead
      // air on a cold cache, and they contend for different resources anyway.
      await Promise.all([
        this.#stages.recognizer.load((p) => this.emit('progress', p)),
        this.#stages.model.load((p) => this.emit('progress', p)),
        this.#stages.synthesizer.load((p) => this.emit('progress', p)),
      ]);

      // Imported lazily: the real detector pulls in onnxruntime-web and the
      // Silero weights, which should not be in the initial bundle and must not
      // be in the import graph of a headless test.
      if (!this.#vad) {
        const { VoiceActivityDetector } = await import('./vad.js');
        this.#vad = new VoiceActivityDetector();
      }

      await this.#vad.start({
        onSpeechStart: () => this.#handleSpeechStart(),
        onSpeechEnd: (audio) => void this.#handleSpeechEnd(audio),
      });

      await this.#runInterviewerTurn();
    } catch (err) {
      this.#fail(err);
    }
  }

  /**
   * Barge-in. Speech during playback (or while we are mid-generation) means the
   * learner has taken the floor, so the current turn is abandoned immediately.
   */
  #handleSpeechStart(): void {
    if (this.#state !== 'speaking' && this.#state !== 'thinking') return;

    const sincePlayback = performance.now() - this.#playbackStartedAt;
    if (this.#state === 'speaking' && sincePlayback < BARGE_IN_GUARD_MS) return;

    if (this.#timings) this.#timings.bargedIn = true;
    this.#stages.synthesizer.stop();
    this.#turnAbort?.abort();
  }

  async #handleSpeechEnd(audio: Float32Array): Promise<void> {
    if (this.#state === 'ended' || this.#state === 'error') return;

    // Anchor every latency measurement to the moment the learner stopped
    // talking — that is the silence they actually experience.
    const speechEndedAt = performance.now();
    this.#timings = { speechEndedAt };
    this.#setState('transcribing');

    try {
      const result = await this.#stages.recognizer.transcribe(audio, 16_000);
      this.#timings.sttMs = performance.now() - speechEndedAt;

      // Whisper hallucinates stock phrases ("Thank you.", "Bye.") on near-silent
      // input. Dropping short transcripts costs a genuine one-word answer
      // occasionally; not dropping them derails the interview constantly.
      if (result.text.trim().length < 2) {
        this.#setState('listening');
        return;
      }

      this.#pushTurn({
        id: crypto.randomUUID(),
        role: 'learner',
        text: result.text,
        startedAt: Date.now(),
        ...(result.confidence !== undefined ? { asrConfidence: result.confidence } : {}),
        ...(this.#timings.bargedIn ? { bargedIn: true } : {}),
      });

      await this.#runInterviewerTurn();
    } catch (err) {
      this.#fail(err);
    }
  }

  /** Generates and speaks one interviewer turn, streaming sentence by sentence. */
  async #runInterviewerTurn(): Promise<void> {
    const abort = new AbortController();
    this.#turnAbort = abort;
    const anchor = this.#timings?.speechEndedAt ?? performance.now();

    this.#setState('thinking');

    let full = '';
    let buffer = '';
    let firstToken = true;

    try {
      const stream = this.#stages.model.generate(this.#buildMessages(), {
        signal: abort.signal,
        maxTokens: 160,
      });

      for await (const delta of stream) {
        if (abort.signal.aborted) break;

        if (firstToken) {
          firstToken = false;
          if (this.#timings) this.#timings.firstTokenMs = performance.now() - anchor;
        }

        full += delta;
        buffer += delta;
        this.emit('interviewerDelta', full);

        const [chunks, remainder] = splitSpeakableChunks(buffer);
        buffer = remainder;
        for (const chunk of chunks) this.#enqueueSpeech(chunk, abort, anchor);
      }

      // Whatever did not end in terminal punctuation still has to be spoken.
      const tail = buffer.trim();
      if (tail && !abort.signal.aborted) this.#enqueueSpeech(tail, abort, anchor);

      await this.#speakQueue;

      if (abort.signal.aborted) {
        // Barged in. Record what was actually said aloud, not what was
        // generated, or the transcript claims the interviewer asked something
        // the learner never heard and the next turn follows a phantom thread.
        if (full.trim()) this.#recordInterviewerTurn(full, anchor, true);
        this.#setState('listening');
        return;
      }

      if (this.#timings) {
        this.#timings.turnaroundMs = performance.now() - anchor;
        this.emit('timings', this.#timings);
      }

      this.#recordInterviewerTurn(full, anchor, false);
      this.#interviewerTurnCount += 1;

      if (this.#interviewerTurnCount >= this.scenario.maxTurns) {
        await this.end();
        return;
      }

      this.#setState('listening');
    } catch (err) {
      if (isAbortError(err)) {
        this.#setState('listening');
        return;
      }
      this.#fail(err);
    }
  }

  #recordInterviewerTurn(text: string, anchor: number, truncated: boolean): void {
    this.#pushTurn({
      id: crypto.randomUUID(),
      role: 'interviewer',
      text: text.trim(),
      startedAt: Date.now(),
      durationMs: performance.now() - anchor,
      ...(truncated ? { bargedIn: true } : {}),
    });
  }

  /**
   * Appends a sentence to the serial playback queue.
   *
   * Chained rather than awaited so generation keeps running while audio plays —
   * overlapping the two is what makes the cascade feel responsive.
   */
  #enqueueSpeech(text: string, abort: AbortController, anchor: number): void {
    this.#speakQueue = this.#speakQueue
      .then(async () => {
        if (abort.signal.aborted) return;

        if (this.#timings && this.#timings.firstAudioMs === undefined) {
          this.#timings.firstAudioMs = performance.now() - anchor;
        }
        this.#playbackStartedAt = performance.now();
        this.#setState('speaking');

        await this.#stages.synthesizer.speak(text, abort.signal);
      })
      .catch((err: unknown) => {
        // An abort here is barge-in working as designed. Anything else is a
        // synthesiser fault: report it but keep the queue alive, because a
        // rejected queue promise would silently swallow every later sentence.
        if (!isAbortError(err)) this.emit('error', toError(err));
      });
  }

  /** Maps the transcript into the model's chat format. */
  #buildMessages(): ChatMessage[] {
    return [
      { role: 'system', content: this.prompt.system },
      ...this.#turns
        .filter((t) => t.role !== 'system')
        .map((t): ChatMessage => ({
          role: t.role === 'interviewer' ? 'assistant' : 'user',
          content: t.text,
        })),
    ];
  }

  #pushTurn(turn: Turn): void {
    this.#turns.push(turn);
    this.emit('turn', turn);
  }

  #fail(err: unknown): void {
    this.#setState('error');
    this.emit('error', toError(err));
  }

  /** Ends the session and releases the mic, GPU memory and audio graph. */
  async end(): Promise<void> {
    this.#turnAbort?.abort();
    this.#stages.synthesizer.stop();
    await this.#vad?.destroy();
    this.#setState('ended');
  }

  /**
   * Streams post-session coaching feedback.
   *
   * Runs after `end()`, on the same model instance, which is why `end()`
   * releases the microphone but does not unload weights: reloading a 1GB model
   * to write three sentences of feedback would take longer than the interview.
   *
   * This is a separate prompt rather than a final interviewer turn so the
   * interviewer can never see assessment criteria mid-session — the leakage
   * that the rubric's critical `answer_leakage` dimension exists to catch.
   */
  async *debrief(signal?: AbortSignal): AsyncIterable<string> {
    const prompt = compileCoachPrompt({
      scenario: this.scenario,
      learner: this.#learner,
      focus: this.prompt.focus,
    });

    const transcript = this.#turns
      .filter((t) => t.role !== 'system')
      .map((t) => `${t.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
      .join('\n');

    yield* this.#stages.model.generate(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: transcript },
      ],
      // Lower temperature than the interview: feedback should be stable and
      // quotable, not creative. Larger budget because it is three paragraphs.
      { temperature: 0.3, maxTokens: 400, ...(signal ? { signal } : {}) },
    );
  }

  /** Full teardown including model unload. Call when leaving the screen. */
  async dispose(): Promise<void> {
    await this.end();
    await Promise.allSettled([
      this.#stages.recognizer.unload?.(),
      this.#stages.model.unload?.(),
      this.#stages.synthesizer.unload?.(),
    ]);
    this.removeAllListeners();
  }

  get learner(): LearnerState {
    return this.#learner;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
