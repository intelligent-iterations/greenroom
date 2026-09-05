import {
  ThinkingStripper,
  type ChatMessage,
  type GenerateOptions,
  type LanguageModel,
  type LoadProgress,
  type SpeechRecognizer,
  type SpeechSynthesizer,
  type TranscriptionResult,
} from '@greenroom/shared';
import { logEvent } from './diagnostics.js';
import type { WorkerRequest, WorkerResponse } from './inference.worker.js';

/**
 * Main-thread facade over the inference worker.
 *
 * Presents the same three stage interfaces the orchestrator already depends on,
 * so moving inference off the main thread changed nothing in the voice loop —
 * which is the payoff for having defined those interfaces in the first place.
 *
 * What stays on the main thread is what has to: the microphone, the VAD, and
 * audio playback. All three are cheap. Everything expensive is behind
 * postMessage, so the main thread stays responsive enough to notice the learner
 * interrupting — the whole point of the exercise.
 */
/** How long to wait for a suspended AudioContext before giving up on it. */
const RESUME_TIMEOUT_MS = 500;

/** Slack added to a clip's duration before the playback guard fires. */
const PLAYBACK_GUARD_MS = 1000;

export class InferencePipeline {
  readonly recognizer: SpeechRecognizer;
  readonly model: LanguageModel;
  readonly synthesizer: SpeechSynthesizer;

  #worker: Worker;
  #nextId = 1;
  #loadPromise?: Promise<void>;
  #onProgress?: (p: LoadProgress) => void;

  /** Resolvers for one-shot requests (transcribe, synthesize, warmUp). */
  #pending = new Map<number, { resolve: (value: never) => void; reject: (e: Error) => void }>();
  /** Delta sinks for in-flight generations. */
  #streams = new Map<number, { push: (t: string) => void; end: (e?: Error) => void }>();

  #audio?: AudioContext;
  #source?: AudioBufferSourceNode;

  constructor(
    private language: 'en' | 'fr' = 'en',
    /** Hugging Face repo of the chosen interviewer model; manifest default if unset. */
    private llmRepo?: string,
  ) {
    this.#worker = new Worker(new URL('./inference.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.#worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) =>
      this.#handle(e.data),
    );

    this.recognizer = {
      id: 'worker:whisper',
      load: (p) => this.load(p),
      transcribe: (audio) => this.#transcribe(audio),
    };

    this.model = {
      id: 'worker:llm',
      load: (p) => this.load(p),
      warmUp: (systemPrompt) => this.#request<void>({ type: 'warmUp', systemPrompt }),
      generate: (messages, options) => this.#generate(messages, options),
    };

    this.synthesizer = {
      id: 'worker:kokoro',
      load: (p) => this.load(p),
      speak: (text, signal) => this.#speak(text, signal),
      stop: () => this.#stopPlayback(),
    };
  }

  /** Loads all three models once, however many stages ask for it. */
  load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (onProgress) this.#onProgress = onProgress;
    this.#loadPromise ??= new Promise<void>((resolve, reject) => {
      this.#pending.set(0, {
        resolve: resolve as (v: never) => void,
        reject,
      });
      this.#post({ type: 'load', language: this.language, ...(this.llmRepo ? { llmRepo: this.llmRepo } : {}) });
    });
    return this.#loadPromise;
  }

  #post(message: WorkerRequest, transfer?: Transferable[]): void {
    if (transfer) this.#worker.postMessage(message, transfer);
    else this.#worker.postMessage(message);
  }

  #handle(message: WorkerResponse): void {
    switch (message.type) {
      case 'progress':
        this.#onProgress?.({ stage: message.stage, progress: message.progress });
        break;

      case 'ready':
        logEvent('models.ready');
        this.#pending.get(0)?.resolve(undefined as never);
        this.#pending.delete(0);
        break;

      case 'warmedUp':
        // Warm-up is fire-and-forget in effect: resolve whoever is waiting.
        for (const [id, p] of this.#pending) {
          if (id !== 0) {
            p.resolve(undefined as never);
            this.#pending.delete(id);
            break;
          }
        }
        break;

      case 'transcript':
        this.#pending.get(message.id)?.resolve({ text: message.text } as never);
        this.#pending.delete(message.id);
        break;

      case 'audio':
        this.#pending.get(message.id)?.resolve(message as never);
        this.#pending.delete(message.id);
        break;

      case 'delta':
        this.#streams.get(message.id)?.push(message.text);
        break;

      case 'generated':
        this.#streams.get(message.id)?.end();
        break;

      case 'error': {
        logEvent('worker.error', { message: message.message, id: message.id });
        const error = new Error(message.message);
        if (message.id !== undefined) {
          this.#pending.get(message.id)?.reject(error);
          this.#pending.delete(message.id);
          this.#streams.get(message.id)?.end(error);
        } else {
          this.#pending.get(0)?.reject(error);
          this.#pending.delete(0);
        }
        break;
      }
    }
  }

  /**
   * Sends a request that expects exactly one reply, keyed by a correlation id.
   *
   * The request union is discriminated on `type` and only some members carry an
   * `id`, which does not express well as a generic parameter; the cast is
   * confined here rather than spread across every call site.
   */
  #request<T>(message: { type: WorkerRequest['type'] } & Record<string, unknown>): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.#post({ ...message, id } as unknown as WorkerRequest);
    });
  }

  async #transcribe(audio: Float32Array): Promise<TranscriptionResult> {
    // Copied before transfer: the caller's buffer belongs to the VAD, which
    // reuses it, and transferring would detach it out from under them.
    const copy = new Float32Array(audio);
    const id = this.#nextId++;
    return new Promise<TranscriptionResult>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.#post({ type: 'transcribe', id, audio: copy }, [copy.buffer]);
    });
  }

  async *#generate(messages: ChatMessage[], options: GenerateOptions = {}): AsyncIterable<string> {
    const id = this.#nextId++;
    const queue: string[] = [];
    let notify: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;

    this.#streams.set(id, {
      push: (text) => {
        queue.push(text);
        notify?.();
      },
      end: (error) => {
        failure = error;
        finished = true;
        notify?.();
      },
    });

    const onAbort = () => {
      // Real interruption: stops decoding in the worker rather than merely
      // ceasing to read from it.
      this.#post({ type: 'interrupt' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    this.#post({
      type: 'generate',
      id,
      messages,
      maxTokens: options.maxTokens ?? 160,
      temperature: options.temperature ?? 0.6,
    });

    const stripper = new ThinkingStripper();

    try {
      while (!finished || queue.length > 0) {
        if (options.signal?.aborted) break;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = undefined;
          continue;
        }
        const speakable = stripper.push(queue.shift()!);
        if (speakable) yield speakable;
      }

      if (!options.signal?.aborted) {
        if (failure) throw failure;
        const tail = stripper.flush();
        if (tail) yield tail;
      }
    } finally {
      this.#streams.delete(id);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #speak(text: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const result = await this.#request<{ samples: Float32Array; sampleRate: number }>({
      type: 'synthesize',
      text,
    });
    // Synthesis is not instant; the learner may have barged in while it ran.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    this.#audio ??= new AudioContext();

    // `resume()` on a context that has never had a user gesture does not
    // reject — it simply never settles. Awaiting it unguarded deadlocks the
    // whole voice loop: speak() never resolves, the speech queue never drains,
    // and the session hangs with no error anywhere. Racing it bounds the wait.
    if (this.#audio.state === 'suspended') {
      await Promise.race([
        this.#audio.resume(),
        new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS)),
      ]);
    }

    const buffer = this.#audio.createBuffer(1, result.samples.length, result.sampleRate);
    buffer.getChannelData(0).set(result.samples);

    const source = this.#audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#audio.destination);
    this.#source = source;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        signal?.removeEventListener('abort', onAbort);
        if (this.#source === source) this.#source = undefined;
        fn();
      };

      const onAbort = () => finish(() => {
        this.#stopPlayback();
        reject(new DOMException('Aborted', 'AbortError'));
      });

      // Safety net. `onended` does not fire if the context is still suspended,
      // and a turn that never finishes speaking blocks every turn after it.
      // Better to continue the conversation slightly early than to hang.
      const guard = setTimeout(
        () => finish(resolve),
        buffer.duration * 1000 + PLAYBACK_GUARD_MS,
      );

      signal?.addEventListener('abort', onAbort, { once: true });
      source.onended = () => finish(resolve);
      source.start();
    });
  }

  #stopPlayback(): void {
    if (!this.#source) return;
    try {
      this.#source.stop();
    } catch {
      // Already stopped or never started.
    }
    this.#source = undefined;
  }

  /**
   * Unlocks audio output. Must be called from a user gesture.
   *
   * Browsers refuse to start an AudioContext without one, and the refusal is
   * silent — playback simply never begins. Calling this from the click that
   * starts a session is what makes the interviewer audible at all.
   */
  async primeAudio(): Promise<void> {
    this.#audio ??= new AudioContext();
    const before = this.#audio.state;
    if (this.#audio.state === 'suspended') {
      await Promise.race([
        this.#audio.resume(),
        new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS)),
      ]);
    }
    // If this still reads "suspended", the interviewer will be inaudible and
    // the guard timers will be doing all the work.
    logEvent('audio.primed', { before, after: this.#audio.state });
  }

  /** Drops the attention cache. Call when starting a new conversation. */
  resetCache(): void {
    this.#post({ type: 'resetCache' });
  }

  async dispose(): Promise<void> {
    this.#stopPlayback();
    await this.#audio?.close();
    this.#audio = undefined;
    this.#worker.terminate();
  }
}
