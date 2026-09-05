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
  type PromptStyle,
  type Turn,
  type TurnTimings,
} from '@greenroom/shared';
import { logEvent } from './diagnostics.js';
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
  /**
   * How much prompt the model can follow. On-device models get 'compact';
   * see the note on PromptStyle for why this is a capability decision.
   */
  promptStyle?: PromptStyle;
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
  prompt: CompiledPrompt;

  #stages: SessionStages;
  #learner: LearnerState;
  #vad?: VadController;
  #state: SessionState = 'idle';
  #turns: Turn[] = [];
  #interviewerTurnCount = 0;

  /** Aborts the in-flight interviewer turn. Replaced each turn. */
  #turnAbort?: AbortController;
  #promptStyle: PromptStyle;
  /** Which required question the interviewer is working toward. */
  #questionIndex = 0;
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
    this.#promptStyle = config.promptStyle ?? 'full';
    this.prompt = this.#compilePrompt();
  }

  /**
   * Recompiles the system prompt for the current point in the interview.
   *
   * The compact prompt names the single question to work toward rather than
   * listing them all and asking the model to remember what it has covered.
   * Coverage is bookkeeping, and software is better at it than a 1.7B model.
   */
  #compilePrompt(): CompiledPrompt {
    const questions = this.scenario.requiredQuestions;
    const index = Math.min(this.#questionIndex, questions.length - 1);
    return compileInterviewerPrompt({
      scenario: this.scenario,
      learner: this.#learner,
      style: this.#promptStyle,
      ...(questions[index] ? { nextQuestion: questions[index] } : {}),
    });
  }

  get state(): SessionState {
    return this.#state;
  }

  get turns(): readonly Turn[] {
    return this.#turns;
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    logEvent('state', { from: this.#state, to: state });
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

      // Compile shaders and prefill a realistic prompt while the learner is
      // still looking at the loading screen. Without this the cost lands on the
      // opening question — the first thing they ever hear from the product.
      await this.#stages.model.warmUp?.(this.prompt.system);

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
    const sincePlayback = Math.round(performance.now() - this.#playbackStartedAt);

    if (this.#state !== 'speaking' && this.#state !== 'thinking') {
      logEvent('vad.speechStart.ignored', { state: this.#state });
      return;
    }

    if (this.#state === 'speaking' && sincePlayback < BARGE_IN_GUARD_MS) {
      // Most likely the interviewer's own voice leaking into the microphone
      // before echo cancellation has converged. Recorded because if barge-in
      // feels unresponsive, this is the first number to question.
      logEvent('vad.speechStart.withinGuard', { sincePlaybackMs: sincePlayback, guardMs: BARGE_IN_GUARD_MS });
      return;
    }

    logEvent('bargeIn', { state: this.#state, sincePlaybackMs: sincePlayback });

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
    logEvent('vad.speechEnd', { samples: audio.length, seconds: +(audio.length / 16000).toFixed(2) });
    this.#setState('transcribing');

    try {
      const result = await this.#stages.recognizer.transcribe(audio, 16_000);
      this.#timings.sttMs = performance.now() - speechEndedAt;

      // Whisper hallucinates stock phrases ("Thank you.", "Bye.") on near-silent
      // input. Dropping short transcripts costs a genuine one-word answer
      // occasionally; not dropping them derails the interview constantly.
      logEvent('stt.transcript', {
        ms: Math.round(this.#timings.sttMs ?? 0),
        text: result.text,
      });

      if (result.text.trim().length < 2) {
        logEvent('stt.discarded', { reason: 'too short', text: result.text });
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
    // Recompiled each turn so the prompt names the question currently being
    // worked toward. Cheap: it is a pure function of scenario and learner.
    (this as { prompt: CompiledPrompt }).prompt = this.#compilePrompt();

    const abort = new AbortController();
    this.#turnAbort = abort;
    const anchor = this.#timings?.speechEndedAt ?? performance.now();

    this.#setState('thinking');

    let full = '';
    let buffer = '';
    let firstToken = true;
    // Tracks the clause-break allowance within this turn. Distinct from the
    // timing field, which is only set once playback actually begins.
    let spokeThisTurn = false;

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
          logEvent('llm.firstToken', { ms: Math.round(performance.now() - anchor) });
        }

        full += delta;
        buffer += delta;
        this.emit('interviewerDelta', full);

        // Until this turn has made a sound, accept a clause boundary so audio
        // starts sooner. Once it is speaking, hold out for whole sentences —
        // they carry better prosody and the learner is no longer waiting.
        const [chunks, remainder] = splitSpeakableChunks(buffer, {
          allowClauseBreak: this.#timings?.firstAudioMs === undefined && !spokeThisTurn,
        });
        buffer = remainder;
        for (const chunk of chunks) {
          spokeThisTurn = true;
          logEvent('tts.enqueue', { chars: chunk.length, clause: !this.#timings?.firstAudioMs });
          this.#enqueueSpeech(chunk, abort, anchor);
        }
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
        logEvent('turn.complete', {
          turnaroundMs: Math.round(this.#timings.turnaroundMs),
          words: full.trim().split(/\s+/).length,
        });
        this.emit('timings', this.#timings);
      }

      this.#recordInterviewerTurn(full, anchor, false);
      this.#interviewerTurnCount += 1;
      // One required question, then room for a single follow-up, then move on.
      this.#questionIndex = Math.floor(this.#interviewerTurnCount / 2);

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
          logEvent('tts.firstAudio', { ms: Math.round(this.#timings.firstAudioMs) });
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
    const history = this.#turns
      .filter((t) => t.role !== 'system')
      .map((t): ChatMessage => ({
        role: t.role === 'interviewer' ? 'assistant' : 'user',
        content: t.text,
      }));

    // Small models handle a system prompt with no user turn badly — measured,
    // the same model that asks a competent question with one user message
    // answers a bare system prompt with a single word. Seeding the opening
    // gives it something to respond to. It is never shown to the learner.
    if (history.length === 0) {
      history.push({ role: 'user', content: "I'm ready to begin." });
    }

    return [{ role: 'system', content: this.prompt.system }, ...history];
  }

  #pushTurn(turn: Turn): void {
    this.#turns.push(turn);
    this.emit('turn', turn);
  }

  #fail(err: unknown): void {
    logEvent('error', { message: err instanceof Error ? err.message : String(err) });
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
