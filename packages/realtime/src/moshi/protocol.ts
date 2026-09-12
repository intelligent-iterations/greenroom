/**
 * Moshi's WebSocket wire format.
 *
 * Transcribed from the reference client at kyutai-labs/moshi
 * (`client/src/protocol/`), not guessed. Every frame is one byte of type
 * followed by its payload:
 *
 * ```
 *   0x00  handshake   [version, model]
 *   0x01  audio       Opus packet
 *   0x02  text        UTF-8
 *   0x03  control     [action]
 *   0x04  metadata    UTF-8 JSON
 *   0x05  error       UTF-8
 *   0x06  ping        (no payload)
 *   0x07  coloredtext [color, ...UTF-8]
 * ```
 *
 * Kept pure and separate from the socket so the format can be tested exactly —
 * byte for byte, both directions — without a server, a GPU or a network. A
 * protocol bug that only shows up against live hardware is the most expensive
 * kind to find, and this is the half that does not need hardware to be certain
 * about.
 *
 * Note `0x02` is *send* text and `0x07` is the coloured text the server sends
 * back. The reference encoder writes a colour byte into a `0x02` frame for
 * "coloredtext" while the decoder reads colour from `0x07`; both are
 * reproduced here as they are, because matching the implementation matters more
 * than tidying it.
 */

export const MESSAGE = {
  handshake: 0x00,
  audio: 0x01,
  text: 0x02,
  control: 0x03,
  metadata: 0x04,
  error: 0x05,
  ping: 0x06,
  coloredText: 0x07,
} as const;

/** Server-side turn control. Values are the reference client's. */
export const CONTROL = {
  start: 0b0000_0000,
  endTurn: 0b0000_0001,
  pause: 0b0000_0010,
  restart: 0b0000_0011,
} as const;

export type ControlAction = keyof typeof CONTROL;

export type MoshiMessage =
  | { type: 'handshake'; version: number; model: number }
  | { type: 'audio'; data: Uint8Array }
  | { type: 'text'; text: string }
  | { type: 'coloredText'; color: number; text: string }
  | { type: 'control'; action: ControlAction }
  | { type: 'metadata'; data: unknown }
  | { type: 'error'; message: string }
  | { type: 'ping' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(type: number, payload?: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + (payload?.length ?? 0));
  out[0] = type;
  if (payload) out.set(payload, 1);
  return out;
}

export function encodeMessage(message: MoshiMessage): Uint8Array {
  switch (message.type) {
    case 'handshake':
      return new Uint8Array([MESSAGE.handshake, message.version, message.model]);
    case 'audio':
      return frame(MESSAGE.audio, message.data);
    case 'text':
      return frame(MESSAGE.text, encoder.encode(message.text));
    case 'coloredText':
      return frame(
        MESSAGE.text,
        new Uint8Array([message.color, ...encoder.encode(message.text)]),
      );
    case 'control':
      return new Uint8Array([MESSAGE.control, CONTROL[message.action]]);
    case 'metadata':
      return frame(MESSAGE.metadata, encoder.encode(JSON.stringify(message.data)));
    case 'error':
      return frame(MESSAGE.error, encoder.encode(message.message));
    case 'ping':
      return new Uint8Array([MESSAGE.ping]);
  }
}

/**
 * Thrown for a frame this client cannot interpret.
 *
 * A distinct type rather than a generic Error because a session has to tell the
 * difference between "the stream said something unexpected" — survivable, skip
 * the frame — and a transport failure, which is not.
 */
export class MoshiProtocolError extends Error {
  constructor(
    message: string,
    readonly byte?: number,
  ) {
    super(message);
    this.name = 'MoshiProtocolError';
  }
}

export function decodeMessage(data: Uint8Array): MoshiMessage {
  if (data.length === 0) throw new MoshiProtocolError('empty frame');

  const type = data[0];
  const payload = data.subarray(1);

  switch (type) {
    case MESSAGE.handshake:
      // The reference decoder ignores the body and reports zeroes. Read it
      // properly, but tolerate a short frame rather than failing the session on
      // a handshake that is otherwise fine.
      return { type: 'handshake', version: payload[0] ?? 0, model: payload[1] ?? 0 };
    case MESSAGE.audio:
      // A copy, not a view: the caller keeps these while more frames arrive,
      // and a subarray would pin the whole received buffer alive behind it.
      return { type: 'audio', data: new Uint8Array(payload) };
    case MESSAGE.text:
      return { type: 'text', text: decoder.decode(payload) };
    case MESSAGE.coloredText:
      return {
        type: 'coloredText',
        color: payload[0] ?? 0,
        text: decoder.decode(payload.subarray(1)),
      };
    case MESSAGE.control: {
      const action = (Object.keys(CONTROL) as ControlAction[]).find(
        (k) => CONTROL[k] === payload[0],
      );
      if (!action) throw new MoshiProtocolError('unknown control action', payload[0]);
      return { type: 'control', action };
    }
    case MESSAGE.metadata:
      try {
        return { type: 'metadata', data: JSON.parse(decoder.decode(payload)) };
      } catch {
        throw new MoshiProtocolError('metadata was not valid JSON');
      }
    case MESSAGE.error:
      return { type: 'error', message: decoder.decode(payload) };
    case MESSAGE.ping:
      return { type: 'ping' };
    default:
      throw new MoshiProtocolError('unknown message type', type);
  }
}
