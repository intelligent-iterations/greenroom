/**
 * Transcribing during the endpoint wait, instead of after it.
 *
 * The cascade's turn was strictly sequential: the VAD waits `redemptionMs`
 * (800ms here) of silence to be sure the turn is over, fires `onSpeechEnd`, and
 * only *then* does Whisper see the audio. So the 800ms a learner spends already
 * silent is dead time on the critical path — the GPU is idle, the audio is
 * complete, and the one thing standing between them is a timer.
 *
 * This runs the transcription during that window. When the endpoint confirms,
 * the answer is usually already there and `sttMs` collapses toward zero; when
 * the learner was only drawing breath and speech resumes, the speculation is
 * abandoned and nothing is lost but some idle GPU time.
 *
 * This is the honest on-device answer to "can we do realtime". A native duplex
 * model would beat it, and none runs in a browser — transformers.js has no
 * speech-to-speech architecture, and Moshi, the only real open-weight duplex
 * system, ships a GPU server with a thin WebSocket client. Overlapping the
 * stages is the latency that is actually available to us, and it is a real
 * several-hundred-millisecond win rather than a rebrand.
 *
 * ## Why speculation is safe here
 *
 * Whisper transcribes a whole window, so a partial pass over the first half of
 * an utterance cannot be stitched onto the second. That is why this speculates
 * on *silence onset* rather than continuously: at that point the audio is
 * already complete, and everything appended afterwards is silence. The
 * speculative pass and the real one therefore see the same speech.
 *
 * `claim` enforces that rather than assuming it. If more than a redemption
 * window of audio arrived after the speculation started, the learner said
 * something new, the speculation is discarded, and the full audio is
 * transcribed normally. Getting this wrong would put words in a learner's
 * mouth, so the check is the point of the module.
 */
import { logEvent } from './diagnostics.js';

export interface TranscriptResult {
  text: string;
  confidence?: number;
}

export interface Transcriber {
  transcribe(audio: Float32Array, sampleRate: number): Promise<TranscriptResult>;
}

/** How the transcript for a turn was obtained, for measurement and diagnostics. */
export type TranscriptSource =
  /** A speculation covered this turn: transcription overlapped the endpoint wait. */
  | 'speculative'
  /** No speculation, or it was invalidated. Transcribed from scratch. */
  | 'full';

export interface ClaimedTranscript extends TranscriptResult {
  source: TranscriptSource;
  /**
   * Milliseconds the learner waited at the endpoint for this transcript.
   *
   * The number that matters, and the reason there is no "was it ready" enum:
   * a boolean for "had it finished" is a race against a microtask and says
   * less than the measurement it approximates. Near zero means the speculation
   * was already done and the learner waits for nothing; a `full` source reports
   * an entire transcription, which is what the sequential path always cost.
   */
  waitedMs: number;
}

const SAMPLE_RATE = 16_000;

/**
 * Default tolerance for audio appended after speculation began.
 *
 * The final buffer is legitimately longer than the speculative one by the
 * silence the VAD spent measuring (`redemptionMs`, 800ms) plus a margin for
 * frame quantisation. Anything beyond that is speech the speculation never saw.
 *
 * Derive this from the VAD's own configuration rather than hardcoding it —
 * `toleranceFor()` exists so that raising `redemptionMs` cannot silently turn
 * every speculation into a discard, or worse, leave a tolerance so wide that
 * real speech slips inside it.
 *
 * One-sided on purpose. Too strict costs a speculation and nothing else; too
 * loose attributes words to a learner that were never transcribed. The failure
 * modes are not symmetric, so this errs toward discarding.
 */
export function toleranceFor(redemptionMs: number): number {
  return redemptionMs + 400;
}

const DEFAULT_TOLERANCE_MS = toleranceFor(800);

export class SpeculativeTranscriber {
  #transcriber: Transcriber;
  #toleranceMs: number;
  #pending?: {
    audio: Float32Array;
    promise: Promise<TranscriptResult>;
    startedAt: number;
  };

  constructor(transcriber: Transcriber, toleranceMs: number = DEFAULT_TOLERANCE_MS) {
    this.#transcriber = transcriber;
    this.#toleranceMs = toleranceMs;
  }

  /** True while a speculation is outstanding. */
  get speculating(): boolean {
    return this.#pending !== undefined;
  }

  /**
   * Begin transcribing `audio` on the assumption the turn has ended.
   *
   * Cheap to call wrongly and safe to call twice — a speculation already in
   * flight is kept rather than restarted, because the first one started earlier
   * and is therefore closer to being useful.
   */
  speculate(audio: Float32Array): void {
    if (this.#pending) return;
    if (audio.length === 0) return;

    const startedAt = performance.now();
    // Errors are captured rather than thrown: a failed speculation must not
    // become an unhandled rejection, and `claim` falls back to a full pass.
    const promise = this.#transcriber
      .transcribe(audio, SAMPLE_RATE)
      .catch((err: unknown) => {
        logEvent('stt.speculation.failed', { error: String(err) });
        return { text: '' } satisfies TranscriptResult;
      });

    this.#pending = { audio, promise, startedAt };
    logEvent('stt.speculation.started', {
      seconds: +(audio.length / SAMPLE_RATE).toFixed(2),
    });
  }

  /**
   * The learner started speaking again — the turn was not over.
   *
   * The in-flight transcription is dropped rather than cancelled; the worker has
   * no cancellation for a single transcribe call, and its result is simply never
   * read. It costs idle GPU time that was free anyway.
   */
  abandon(reason: string): void {
    if (!this.#pending) return;
    logEvent('stt.speculation.abandoned', { reason });
    this.#pending = undefined;
  }

  /**
   * Get the transcript for the turn that just ended.
   *
   * Uses the speculation when it covers the same speech, and otherwise
   * transcribes `finalAudio` from scratch. Always returns a transcript for the
   * audio the learner actually produced.
   */
  async claim(finalAudio: Float32Array): Promise<ClaimedTranscript> {
    const pending = this.#pending;
    this.#pending = undefined;

    if (!pending) return this.#full(finalAudio);

    const appendedMs = ((finalAudio.length - pending.audio.length) / SAMPLE_RATE) * 1000;

    // Shorter than what we speculated on means this is a different utterance
    // entirely, not a continuation. Negative values fail this check too.
    if (appendedMs < 0 || appendedMs > this.#toleranceMs) {
      logEvent('stt.speculation.invalidated', { appendedMs: Math.round(appendedMs) });
      return this.#full(finalAudio);
    }

    // An unfinished speculation is awaited rather than restarted: it began
    // earlier, so it can only finish sooner than a fresh pass would.
    const waitedFrom = performance.now();
    const result = await pending.promise;
    const waitedMs = performance.now() - waitedFrom;

    logEvent('stt.speculation.claimed', {
      waitedMs: Math.round(waitedMs),
      totalMs: Math.round(performance.now() - pending.startedAt),
    });

    return { ...result, source: 'speculative', waitedMs };
  }

  async #full(finalAudio: Float32Array): Promise<ClaimedTranscript> {
    const from = performance.now();
    const result = await this.#transcriber.transcribe(finalAudio, SAMPLE_RATE);
    return { ...result, source: 'full', waitedMs: performance.now() - from };
  }
}
