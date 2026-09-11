import type {
  DuplexAudioChunk,
  DuplexCapabilities,
  DuplexEvent,
  DuplexSessionOptions,
  DuplexVoiceStage,
} from '@greenroom/shared';
import { deferred } from './fakes.js';

/**
 * A duplex transport driven by the test rather than by a vendor.
 *
 * The realtime path has no adapter and no credential, so this is the only thing
 * RealtimeSession has ever talked to. That makes it the whole of the honesty
 * claim: the orchestration below is verified, the vendor path is not.
 *
 * Mirrors ScriptedModel, including the gate being re-armed on every push — a
 * gate left resolved from the previous event makes the consumer's await return
 * instantly and spins the loop at 100% CPU.
 */
export class ScriptedDuplexTransport implements DuplexVoiceStage {
  readonly id = 'fake-duplex';
  capabilities: DuplexCapabilities;

  /** Audio the session pushed upstream, to prove the mic is actually streaming. */
  sent: DuplexAudioChunk[] = [];
  interruptCalls = 0;
  openedWith?: DuplexSessionOptions;
  closed = false;

  #pending: DuplexEvent[] = [];
  #gate = deferred();
  #done = false;

  constructor(capabilities: Partial<DuplexCapabilities> = {}) {
    this.capabilities = {
      userTranscripts: true,
      assistantTranscripts: true,
      transcriptsLeadAudio: true,
      nativeBargeIn: false,
      ...capabilities,
    };
  }

  async load(): Promise<void> {}

  async open(options: DuplexSessionOptions): Promise<void> {
    this.openedWith = options;
  }

  send(chunk: DuplexAudioChunk): void {
    this.sent.push(chunk);
  }

  interrupt(): void {
    this.interruptCalls += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.finish();
  }

  emit(event: DuplexEvent): void {
    this.#pending.push(event);
    this.#gate.resolve();
    this.#gate = deferred();
  }

  finish(): void {
    this.#done = true;
    this.#gate.resolve();
    this.#gate = deferred();
  }

  async *events(): AsyncIterable<DuplexEvent> {
    while (true) {
      if (this.#pending.length > 0) {
        yield this.#pending.shift()!;
        continue;
      }
      if (this.#done) return;
      await this.#gate.promise;
    }
  }
}
