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

export class VoiceActivityDetector implements VadController {
  #vad?: MicVAD;
  #stream?: MediaStream;
  #running = false;

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
        handlers.onSpeechStart();
      },
      onSpeechEnd: (audio) => {
        logEvent('vad.raw.speechEnd', { seconds: +(audio.length / 16000).toFixed(2) });
        handlers.onSpeechEnd(audio);
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
      preSpeechPadMs: 250,
      // A pause mid-utterance should discard it, not submit a half sentence
      // that Whisper will turn into a confident-sounding fragment.
      submitUserSpeechOnPause: false,
      startOnLoad: false,
    });

    await this.#vad.start();
    this.#running = true;
    logEvent('vad.started');
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
