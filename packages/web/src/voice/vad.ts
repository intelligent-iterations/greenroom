import { MicVAD } from '@ricky0123/vad-web';
import { logEvent } from './diagnostics.js';
import type { VadController, VadHandlers, VadOptions } from './vad.types.js';

export type { VadController, VadHandlers, VadOptions } from './vad.types.js';

/**
 * Voice activity detection (Silero v5, ONNX, ~2MB).
 *
 * Endpointing rather than push-to-talk, because a spoken interview where you
 * hold a button is not a spoken interview. The cost is that the mic stays open
 * while the interviewer talks, which creates two problems this module owns:
 *
 *  1. **Echo.** The interviewer's own audio reaches the mic and VAD hears it as
 *     the learner speaking, which barges in on itself in a loop. Handled by
 *     requesting the stream with echoCancellation/noiseSuppression rather than
 *     letting the VAD library open a raw one, and by the orchestrator's
 *     post-speech guard window.
 *  2. **Endpoint tuning.** `redemptionMs` is the silence tolerated before
 *     declaring the turn over, and it trades directly against responsiveness.
 *     The library default is tuned for native speakers issuing commands; this
 *     is neither. Someone composing a sentence in a second language pauses
 *     mid-utterance routinely, and cutting them off is the single most
 *     demoralising thing the product can do, so the default is raised to 800ms
 *     and exposed as an option. It wants tuning against recorded learner audio
 *     per CEFR band rather than left at one value forever.
 */
/** Must match the output directory of scripts/copy-vad-assets.mjs. */
export const VAD_ASSET_PATH = '/vad/';

/**
 * Longest utterance whose frames are buffered for speculation, in seconds.
 *
 * The buffer exists only to hand a speculative transcriber the speech so far.
 * Past this the buffer stops growing and speculation is skipped for the turn —
 * a monologue is exactly where an unbounded Float32Array accumulation would
 * quietly become a memory problem, and the fallback is the old sequential path,
 * which is merely slower rather than broken.
 */
const MAX_BUFFERED_SECONDS = 30;

/**
 * Rolling pre-speech buffer, in ms. Must match `preSpeechPadMs` below.
 *
 * Silero fires `onSpeechStart` a beat after speech actually begins, which is
 * why the library pads the audio it finally emits. A speculative buffer that
 * started at the callback would be missing that pad, so Whisper would see a
 * clipped first word and speculate a transcript subtly different from the real
 * one — the worst kind of wrong, because it would usually be nearly right.
 */
const PRE_SPEECH_PAD_MS = 250;

export class VoiceActivityDetector implements VadController {
  #vad?: MicVAD;
  #stream?: MediaStream;
  #running = false;
  /** Frames captured since the current speech segment began, pad included. */
  #frames: Float32Array[] = [];
  /** Rolling pre-speech frames, kept whether or not anyone is speaking. */
  #preRoll: Float32Array[] = [];
  #preRollSamples = 0;
  #bufferedSamples = 0;
  #speaking = false;
  /** True once silence onset has been reported for this segment. */
  #silenceReported = false;
  #overflowed = false;

  async start(handlers: VadHandlers, options: VadOptions = {}): Promise<void> {
    if (this.#vad) return;

    // Opened here rather than by MicVAD so the echo-cancellation constraints
    // are guaranteed. Without them, self-barge-in is immediate on laptop
    // speakers and the session deadlocks on the first turn.
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    const track = this.#stream.getAudioTracks()[0];
    logEvent('mic.opened', {
      label: track?.label,
      settings: track?.getSettings() as unknown as Record<string, unknown>,
    });

    const stream = this.#stream;
    this.#vad = await MicVAD.new({
      // 0.0.30 takes a stream *factory* rather than a stream. Ours resolves to
      // the already-open echo-cancelled stream so the library never opens a
      // raw one of its own.
      getStream: async () => stream,
      // These assets are fetched over HTTP at runtime, not bundled, and they
      // are copied into public/vad/ by scripts/copy-vad-assets.mjs. Pointing at
      // a subdirectory rather than the origin root matters: with the default
      // './' the SPA rewrite answers a missing file with index.html and a 200,
      // so the library parses HTML as an ONNX model and the microphone dies
      // silently — the app talks and never hears you.
      baseAssetPath: VAD_ASSET_PATH,
      onnxWASMBasePath: VAD_ASSET_PATH,
      // We own the stream's lifetime: pausing must not stop the tracks, or
      // resuming mid-session would re-prompt for microphone permission.
      pauseStream: async () => {},
      resumeStream: async () => stream,
      model: 'v5',
      onSpeechStart: () => {
        logEvent('vad.raw.speechStart');
        // Seed with the pre-roll so the speculative audio carries the same
        // leading pad the library will include in onSpeechEnd.
        const preRoll = this.#preRoll.slice();
        const preRollSamples = this.#preRollSamples;
        this.#resetSegment();
        this.#frames = preRoll;
        this.#bufferedSamples = preRollSamples;
        this.#speaking = true;
        handlers.onSpeechStart();
      },
      onSpeechEnd: (audio) => {
        logEvent('vad.raw.speechEnd', { seconds: +(audio.length / 16000).toFixed(2) });
        this.#resetSegment();
        handlers.onSpeechEnd(audio);
      },

      /**
       * Frame-level probabilities, used only to find the moment speech stops.
       *
       * The library reports the *endpoint* after `redemptionMs` of silence, by
       * which time the learner has already been quiet for most of a second. That
       * delay is unavoidable — it is what stops a mid-sentence breath ending the
       * turn — but it does not have to be idle. This reports the drop as it
       * happens so transcription can overlap the wait.
       */
      onFrameProcessed: (probabilities, frame) => {
        if (!this.#speaking) {
          // Keep just enough history to reconstruct the pad when speech starts.
          this.#preRoll.push(frame);
          this.#preRollSamples += frame.length;
          while (this.#preRollSamples > (PRE_SPEECH_PAD_MS / 1000) * 16_000) {
            const dropped = this.#preRoll.shift();
            if (!dropped) break;
            this.#preRollSamples -= dropped.length;
          }
          return;
        }

        if (this.#bufferedSamples < MAX_BUFFERED_SECONDS * 16_000) {
          this.#frames.push(frame);
          this.#bufferedSamples += frame.length;
        } else if (!this.#overflowed) {
          this.#overflowed = true;
          logEvent('vad.buffer.overflow', { seconds: MAX_BUFFERED_SECONDS });
        }

        const speaking = probabilities.isSpeech >= 0.4;

        if (!speaking && !this.#silenceReported) {
          this.#silenceReported = true;
          if (this.#overflowed) return;
          logEvent('vad.silenceOnset', {
            seconds: +(this.#bufferedSamples / 16_000).toFixed(2),
          });
          handlers.onSilenceOnset?.(this.#concatFrames());
        } else if (speaking && this.#silenceReported) {
          // A breath, not an ending.
          this.#silenceReported = false;
          logEvent('vad.speechResumed');
          handlers.onSpeechResumed?.();
        }
      },
      onVADMisfire: () => {
        // Speech too short to count. If the learner says something brief and
        // nothing happens, this is where it went.
        logEvent('vad.misfire');
        handlers.onMisfire?.();
      },
      // Raised from the 0.5 default: an aggressive threshold is what stops
      // residual echo and background room noise from opening a turn.
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.4,
      redemptionMs: options.redemptionMs ?? 800,
      minSpeechMs: options.minSpeechMs ?? 150,
      preSpeechPadMs: PRE_SPEECH_PAD_MS,
      // A pause mid-utterance should discard it, not submit a half sentence
      // that Whisper will turn into a confident-sounding fragment.
      submitUserSpeechOnPause: false,
      startOnLoad: false,
    });

    await this.#vad.start();
    this.#running = true;
    logEvent('vad.started');
  }

  #resetSegment(): void {
    this.#frames = [];
    this.#bufferedSamples = 0;
    this.#preRoll = [];
    this.#preRollSamples = 0;
    this.#speaking = false;
    this.#silenceReported = false;
    this.#overflowed = false;
  }

  #concatFrames(): Float32Array {
    const out = new Float32Array(this.#bufferedSamples);
    let at = 0;
    for (const f of this.#frames) {
      out.set(f, at);
      at += f.length;
    }
    return out;
  }

  /** Stops emitting without releasing the mic. Used between sessions. */
  pause(): void {
    if (!this.#running) return;
    // Fire-and-forget: callers treat pausing as immediate, and the library
    // stops emitting synchronously even though teardown resolves later.
    void this.#vad?.pause();
    this.#running = false;
  }

  resume(): void {
    if (this.#running || !this.#vad) return;
    void this.#vad.start();
    this.#running = true;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Releases the mic and drops the browser's recording indicator. */
  async destroy(): Promise<void> {
    this.pause();
    await this.#vad?.destroy();
    this.#vad = undefined;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
  }
}
