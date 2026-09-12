import { describe, expect, it } from 'vitest';
import {
  CONTROL,
  MESSAGE,
  MoshiProtocolError,
  decodeMessage,
  encodeMessage,
  type MoshiMessage,
} from '../moshi/protocol.js';

/**
 * The bytes, exactly.
 *
 * These assertions are against literal byte values rather than a round trip,
 * because a round trip through my own encoder and decoder would pass happily
 * while disagreeing with the server about every frame. The values come from the
 * reference client.
 */
describe('encodeMessage', () => {
  it('writes a handshake as type, version, model', () => {
    expect([...encodeMessage({ type: 'handshake', version: 0, model: 0 })]).toEqual([
      0x00, 0x00, 0x00,
    ]);
  });

  it('prefixes audio with 0x01 and copies the packet', () => {
    const packet = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect([...encodeMessage({ type: 'audio', data: packet })]).toEqual([
      0x01, 0xde, 0xad, 0xbe, 0xef,
    ]);
  });

  it('encodes text as UTF-8 after 0x02', () => {
    expect([...encodeMessage({ type: 'text', text: 'hi' })]).toEqual([0x02, 0x68, 0x69]);
  });

  it('encodes control actions with the documented values', () => {
    expect([...encodeMessage({ type: 'control', action: 'start' })]).toEqual([0x03, 0]);
    expect([...encodeMessage({ type: 'control', action: 'endTurn' })]).toEqual([0x03, 1]);
    expect([...encodeMessage({ type: 'control', action: 'pause' })]).toEqual([0x03, 2]);
    expect([...encodeMessage({ type: 'control', action: 'restart' })]).toEqual([0x03, 3]);
  });

  it('encodes metadata as JSON', () => {
    const bytes = encodeMessage({ type: 'metadata', data: { a: 1 } });
    expect(bytes[0]).toBe(MESSAGE.metadata);
    expect(new TextDecoder().decode(bytes.subarray(1))).toBe('{"a":1}');
  });

  it('encodes a ping as a single byte', () => {
    expect([...encodeMessage({ type: 'ping' })]).toEqual([0x06]);
  });

  it('handles multi-byte characters without truncating', () => {
    // A naive length-in-characters implementation corrupts this.
    const bytes = encodeMessage({ type: 'text', text: 'héllo 👋' });
    expect(new TextDecoder().decode(bytes.subarray(1))).toBe('héllo 👋');
  });
});

describe('decodeMessage', () => {
  it('reads audio back as bytes', () => {
    const msg = decodeMessage(new Uint8Array([0x01, 1, 2, 3]));
    expect(msg).toEqual({ type: 'audio', data: new Uint8Array([1, 2, 3]) });
  });

  it('copies audio rather than viewing the received buffer', () => {
    // A subarray would keep the whole socket buffer alive and, worse, change
    // underneath the consumer if the buffer is reused.
    const frame = new Uint8Array([0x01, 9, 9]);
    const msg = decodeMessage(frame);
    frame[1] = 0;
    expect(msg.type === 'audio' && msg.data[0]).toBe(9);
  });

  it('reads coloured text with its colour byte', () => {
    const frame = new Uint8Array([0x07, 0x05, ...new TextEncoder().encode('hey')]);
    expect(decodeMessage(frame)).toEqual({ type: 'coloredText', color: 5, text: 'hey' });
  });

  it('maps control bytes back to actions', () => {
    expect(decodeMessage(new Uint8Array([0x03, CONTROL.endTurn]))).toEqual({
      type: 'control',
      action: 'endTurn',
    });
  });

  it('rejects an unknown control action', () => {
    expect(() => decodeMessage(new Uint8Array([0x03, 0x7f]))).toThrow(MoshiProtocolError);
  });

  it('rejects an unknown message type', () => {
    expect(() => decodeMessage(new Uint8Array([0x42]))).toThrow(MoshiProtocolError);
  });

  it('rejects an empty frame', () => {
    expect(() => decodeMessage(new Uint8Array([]))).toThrow(MoshiProtocolError);
  });

  it('rejects metadata that is not JSON', () => {
    const frame = new Uint8Array([0x04, ...new TextEncoder().encode('{oops')]);
    expect(() => decodeMessage(frame)).toThrow(MoshiProtocolError);
  });

  it('tolerates a short handshake instead of failing the session', () => {
    expect(decodeMessage(new Uint8Array([0x00]))).toEqual({
      type: 'handshake',
      version: 0,
      model: 0,
    });
  });
});

describe('round trip', () => {
  const cases: MoshiMessage[] = [
    { type: 'handshake', version: 0, model: 0 },
    { type: 'audio', data: new Uint8Array([0, 255, 128]) },
    { type: 'text', text: 'bonjour' },
    { type: 'control', action: 'restart' },
    { type: 'metadata', data: { nested: { ok: true } } },
    { type: 'error', message: 'upstream failed' },
    { type: 'ping' },
  ];

  for (const message of cases) {
    it(`survives a round trip: ${message.type}`, () => {
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
    });
  }
});
