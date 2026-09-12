import type {
  DuplexAudioChunk,
  DuplexCapabilities,
  DuplexEvent,
  DuplexSessionOptions,
  DuplexVoiceStage,
} from '../duplex.js';
import { EventQueue } from '../queue.js';
import { decodeMessage, encodeMessage, MoshiProtocolError } from './protocol.js';

/**
 * Opus, supplied by the caller.
 *
 * Moshi speaks Opus in both directions — the reference client uses
 * `opus-recorder`. This package does not bundle a codec, for two reasons that
 * point the same way: a WebAssembly codec is a large, platform-specific
 * dependency that would be dead weight for anyone using a vendor that speaks
 * PCM, and it is not something this package could honestly claim to have
 * verified without a GPU server to talk to.
 *
 * So the codec is an interface. What ships here is the part that can be proven
 * correct in a unit test — the framing, the ordering, the state machine — and
 * the codec is named rather than faked.
 */
export interface OpusCodec {
  /** PCM float32 in, Opus packets out. May buffer and return nothing. */
  encode(samples: Float32Array, sampleRate: number): Promise<Uint8Array[]>;
  /** One Opus packet in, PCM float32 out. */
  decode(packet: Uint8Array): Promise<Float32Array>;
  /** Sample rate of the PCM `decode` returns. */
  readonly outputSampleRate: number;
  close?(): Promise<void>;
}

/** Just enough of WebSocket to be substitutable in a test. */
export interface SocketLike {
  send(data: ArrayBufferView): void;
  close(): void;
  binaryType: string;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface MoshiOptions {
  /** e.g. `ws://127.0.0.1:8088/api/chat` */
  url: string;
  codec: OpusCodec;
  /** Defaults to the platform WebSocket. Injectable for tests. */
  createSocket?: (url: string) => SocketLike;
  /** Clock, for deterministic tests. Defaults to performance.now. */
  now?: () => number;
}

/**
 * Moshi's capabilities, as the protocol actually presents them.
 *
 * `transcriptsLeadAudio` is false and that is the honest reading: text and
 * audio arrive as independent frames on one socket with no ordering guarantee
 * between them, so a "time to first token" measured here would really be time
 * to whichever frame won. The orchestrator is expected to leave that figure
 * undefined rather than publish a number that means something else.
 *
 * `userTranscripts` is false because Moshi's stream carries the assistant's
 * words; it is a spoken-dialogue model, not a transcription service. Anything
 * needing the user's words must recognise them separately.
 */
export const MOSHI_CAPABILITIES: DuplexCapabilities = {
  userTranscripts: false,
  assistantTranscripts: true,
  transcriptsLeadAudio: false,
  nativeBargeIn: true,
};

/**
 * A full-duplex session against a Moshi server.
 *
 * Moshi is a speech-text foundation model from Kyutai (Apache-2.0) that runs
 * as a server; this is the client half. It is the open-weight option: the model
 * runs on hardware you control rather than a vendor's, which is the closest a
 * browser can currently get to on-device duplex — no speech-to-speech model
 * runs in a browser today.
 */
export class MoshiDuplexStage implements DuplexVoiceStage {
  readonly id = 'moshi';
  readonly capabilities = MOSHI_CAPABILITIES;

  #options: MoshiOptions;
  #socket?: SocketLike;
  #queue = new EventQueue<DuplexEvent>();
  #open = false;
  #now: () => number;
  /** Serialises decode work so audio is emitted in the order it arrived. */
  #decodeChain: Promise<void> = Promise.resolve();

  constructor(options: MoshiOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  async open(options: DuplexSessionOptions = {}): Promise<void> {
    if (this.#open) return;

    const create =
      this.#options.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as SocketLike);

    const socket = create(this.#options.url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error('aborted before the socket opened'));
      options.signal?.addEventListener('abort', onAbort, { once: true });

      socket.addEventListener('open', () => {
        // Version 0, model 0 — the only pair the reference client defines.
        socket.send(encodeMessage({ type: 'handshake', version: 0, model: 0 }));
        this.#open = true;
        resolve();
      });
      socket.addEventListener('error', () => reject(new Error('moshi socket error')));
      socket.addEventListener('close', () => {
        this.#open = false;
        this.#queue.close();
      });
    });

    socket.addEventListener('message', (event) => void this.#receive(event.data));
  }

  async #receive(data: unknown): Promise<void> {
    let message;
    try {
      message = decodeMessage(toBytes(data));
    } catch (err) {
      // A frame this client cannot read is survivable; the stream is not
      // necessarily broken and dropping the session would be an overreaction.
      if (err instanceof MoshiProtocolError) return;
      throw err;
    }

    const at = this.#now();

    switch (message.type) {
      case 'audio': {
        // Decoding is async, so chaining is what keeps playback in order. Without
        // it two packets can finish out of sequence and the voice is scrambled.
        this.#decodeChain = this.#decodeChain.then(async () => {
          try {
            const samples = await this.#options.codec.decode(message.data);
            this.#queue.push({
              type: 'assistant_audio',
              chunk: { samples, sampleRate: this.#options.codec.outputSampleRate },
              at,
            });
          } catch (error) {
            this.#queue.push({ type: 'error', error: asError(error), at: this.#now() });
          }
        });
        break;
      }
      case 'text':
      case 'coloredText':
        // Moshi streams the assistant's words as they are spoken. Never final:
        // the protocol has no end-of-utterance marker on text.
        this.#queue.push({
          type: 'assistant_transcript',
          text: message.text,
          final: false,
          at,
        });
        break;
      case 'control':
        if (message.action === 'endTurn') {
          this.#queue.push({ type: 'assistant_turn_complete', at });
        }
        break;
      case 'error':
        this.#queue.push({ type: 'error', error: new Error(message.message), at });
        break;
      case 'handshake':
      case 'metadata':
      case 'ping':
        break;
    }
  }

  send(chunk: DuplexAudioChunk): void {
    if (!this.#open || !this.#socket) return;
    const socket = this.#socket;
    void this.#options.codec
      .encode(chunk.samples, chunk.sampleRate)
      .then((packets) => {
        for (const packet of packets) {
          if (this.#open) socket.send(encodeMessage({ type: 'audio', data: packet }));
        }
      })
      .catch((error: unknown) => {
        this.#queue.push({ type: 'error', error: asError(error), at: this.#now() });
      });
  }

  events(): AsyncIterable<DuplexEvent> {
    return this.#queue;
  }

  /**
   * Moshi handles interruption itself — it is a full-duplex model and hears you
   * while it speaks. This sends the explicit signal anyway for the case where
   * the caller knows something the audio does not.
   */
  interrupt(): void {
    if (!this.#open || !this.#socket) return;
    this.#socket.send(encodeMessage({ type: 'control', action: 'endTurn' }));
  }

  async close(): Promise<void> {
    this.#open = false;
    this.#socket?.close();
    await this.#decodeChain.catch(() => {});
    this.#queue.close();
    await this.#options.codec.close?.();
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new MoshiProtocolError('expected a binary frame');
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
