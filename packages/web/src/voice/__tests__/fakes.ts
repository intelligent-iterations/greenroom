import type {
  ChatMessage,
  GenerateOptions,
  LanguageModel,
  SpeechRecognizer,
  SpeechSynthesizer,
  TranscriptionResult,
} from '@greenroom/shared';
import type { VadController, VadHandlers } from '../vad.js';

/** A promise plus its resolvers, for driving async stages from a test. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the microtask queue drain so chained promises settle. */
export const flush = () => new Promise((r) => setTimeout(r, 0));

export class FakeVad implements VadController {
  handlers?: VadHandlers;
  running = false;
  destroyed = false;

  async start(handlers: VadHandlers): Promise<void> {
    this.handlers = handlers;
    this.running = true;
  }
  pause(): void {
    this.running = false;
  }
  resume(): void {
    this.running = true;
  }
  async destroy(): Promise<void> {
    this.running = false;
    this.destroyed = true;
  }

  /** Simulates the learner starting to talk. */
  speechStart(): void {
    this.handlers?.onSpeechStart();
  }
  /** Simulates the learner finishing; returns once the turn settles. */
  async speechEnd(samples = 16_000): Promise<void> {
    this.handlers?.onSpeechEnd(new Float32Array(samples));
    await flush();
  }
}

export class FakeRecognizer implements SpeechRecognizer {
  readonly id = 'fake-stt';
  transcripts: string[] = [];
  calls = 0;

  constructor(transcripts: string[] = []) {
    this.transcripts = transcripts;
  }
  async load(): Promise<void> {}
  async transcribe(): Promise<TranscriptionResult> {
    const text = this.transcripts[this.calls] ?? 'a default answer about the migration';
    this.calls += 1;
    return { text };
  }
}

/**
 * A model whose stream is driven by the test: `push()` emits a delta, `finish()`
 * closes the turn. Lets a test hold the stream open at an exact point, which is
 * how barge-in has to be exercised.
 */
export class ScriptedModel implements LanguageModel {
  readonly id = 'fake-llm';
  receivedMessages: ChatMessage[][] = [];
  #pending: string[] = [];
  #gate = deferred();
  #done = false;
  aborted = false;

  async load(): Promise<void> {}

  push(delta: string): void {
    this.#pending.push(delta);
    this.#gate.resolve();
    this.#gate = deferred();
  }

  finish(): void {
    this.#done = true;
    this.#gate.resolve();
    this.#gate = deferred();
  }

  /** Emits a whole response and closes, for tests that do not need control. */
  script(text: string): void {
    this.push(text);
    this.finish();
  }

  async *generate(messages: ChatMessage[], options: GenerateOptions = {}): AsyncIterable<string> {
    this.receivedMessages.push(messages);
    // Reset per call. Leaving a resolved gate behind from the previous turn
    // makes the wait below return instantly and spins the loop at 100% CPU.
    this.#done = false;
    this.#gate = deferred();

    const aborted = new Promise<void>((resolve) => {
      if (!options.signal) return;
      if (options.signal.aborted) return resolve();
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    while (true) {
      if (options.signal?.aborted) {
        this.aborted = true;
        return;
      }
      if (this.#pending.length > 0) {
        yield this.#pending.shift()!;
        continue;
      }
      if (this.#done) return;
      await Promise.race([this.#gate.promise, aborted]);
    }
  }
}

/** Records what was spoken. Each utterance resolves only when released. */
export class FakeSynthesizer implements SpeechSynthesizer {
  readonly id = 'fake-tts';
  spoken: string[] = [];
  stopCalls = 0;
  /** When true, utterances resolve immediately instead of waiting. */
  autoResolve: boolean;
  #current?: { resolve: () => void; reject: (e: unknown) => void };

  constructor(autoResolve = true) {
    this.autoResolve = autoResolve;
  }

  async load(): Promise<void> {}

  speak(text: string, signal?: AbortSignal): Promise<void> {
    this.spoken.push(text);
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (this.autoResolve) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      this.#current = { resolve, reject };
      signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  }

  /** Completes the utterance currently "playing". */
  release(): void {
    this.#current?.resolve();
    this.#current = undefined;
  }

  stop(): void {
    this.stopCalls += 1;
    this.#current?.reject(new DOMException('Aborted', 'AbortError'));
    this.#current = undefined;
  }
}
