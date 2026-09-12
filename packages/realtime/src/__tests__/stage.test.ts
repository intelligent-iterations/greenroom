import { describe, expect, it, vi } from 'vitest';
import { MoshiDuplexStage, type OpusCodec, type SocketLike } from '../moshi/stage.js';
import { encodeMessage } from '../moshi/protocol.js';
import type { DuplexEvent } from '../duplex.js';

/** A WebSocket the test drives by hand. */
function fakeSocket() {
  const listeners = new Map<string, ((arg?: unknown) => void)[]>();
  const sent: Uint8Array[] = [];
  const socket: SocketLike = {
    binaryType: '',
    send: (data) => sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))),
    close: () => listeners.get('close')?.forEach((l) => l()),
    addEventListener: (type: string, listener: (arg?: unknown) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
  } as SocketLike;
  return {
    socket,
    sent,
    fire: (type: string, arg?: unknown) => listeners.get(type)?.forEach((l) => l(arg)),
    deliver: (bytes: Uint8Array) =>
      listeners.get('message')?.forEach((l) => l({ data: bytes.buffer } as never)),
  };
}

/** An Opus codec that is really identity, so the test observes ordering only. */
const passthrough = (decodeDelays: number[] = []): OpusCodec => {
  let call = 0;
  return {
    outputSampleRate: 24_000,
    encode: async (samples) => [new Uint8Array(samples.length)],
    decode: async (packet) => {
      const delay = decodeDelays[call++] ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return new Float32Array(packet.length);
    },
  };
};

async function take(stage: MoshiDuplexStage, n: number): Promise<DuplexEvent[]> {
  const out: DuplexEvent[] = [];
  for await (const event of stage.events()) {
    out.push(event);
    if (out.length === n) break;
  }
  return out;
}

describe('MoshiDuplexStage', () => {
  it('sends a handshake as soon as the socket opens', async () => {
    const f = fakeSocket();
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec: passthrough(),
      createSocket: () => f.socket,
    });
    const opened = stage.open();
    f.fire('open');
    await opened;

    expect([...(f.sent[0] ?? [])]).toEqual([0x00, 0x00, 0x00]);
    expect(f.socket.binaryType).toBe('arraybuffer');
  });

  it('turns text frames into assistant transcript events', async () => {
    const f = fakeSocket();
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec: passthrough(),
      createSocket: () => f.socket,
      now: () => 42,
    });
    const opened = stage.open();
    f.fire('open');
    await opened;

    const events = take(stage, 1);
    f.deliver(encodeMessage({ type: 'text', text: 'hello' }));

    expect(await events).toEqual([
      { type: 'assistant_transcript', text: 'hello', final: false, at: 42 },
    ]);
  });

  it('emits decoded audio in arrival order even when decodes finish out of order', async () => {
    const f = fakeSocket();
    // First packet takes longer than the second: without serialising, the
    // second would be emitted first and the voice would be scrambled.
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec: passthrough([30, 0]),
      createSocket: () => f.socket,
    });
    const opened = stage.open();
    f.fire('open');
    await opened;

    const events = take(stage, 2);
    f.deliver(encodeMessage({ type: 'audio', data: new Uint8Array(10) }));
    f.deliver(encodeMessage({ type: 'audio', data: new Uint8Array(20) }));

    const got = await events;
    expect(got[0]?.type).toBe('assistant_audio');
    expect(got[0]?.type === 'assistant_audio' && got[0].chunk.samples.length).toBe(10);
    expect(got[1]?.type === 'assistant_audio' && got[1].chunk.samples.length).toBe(20);
  });

  it('reports an endTurn control as the turn completing', async () => {
    const f = fakeSocket();
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec: passthrough(),
      createSocket: () => f.socket,
      now: () => 7,
    });
    const opened = stage.open();
    f.fire('open');
    await opened;

    const events = take(stage, 1);
    f.deliver(encodeMessage({ type: 'control', action: 'endTurn' }));
    expect(await events).toEqual([{ type: 'assistant_turn_complete', at: 7 }]);
  });

  it('survives a frame it cannot decode', async () => {
    const f = fakeSocket();
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec: passthrough(),
      createSocket: () => f.socket,
      now: () => 1,
    });
    const opened = stage.open();
    f.fire('open');
    await opened;

    const events = take(stage, 1);
    f.deliver(new Uint8Array([0x42]));            // unknown type — must be skipped
    f.deliver(encodeMessage({ type: 'text', text: 'still here' }));

    expect(await events).toEqual([
      { type: 'assistant_transcript', text: 'still here', final: false, at: 1 },
    ]);
  });

  it('sends an endTurn control on interrupt', async () => {
    const f = fakeSocket();
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec: passthrough(),
      createSocket: () => f.socket,
    });
    const opened = stage.open();
    f.fire('open');
    await opened;

    stage.interrupt();
    expect([...(f.sent.at(-1) ?? [])]).toEqual([0x03, 0x01]);
  });

  it('does not send audio before the socket is open or after close', async () => {
    const f = fakeSocket();
    const codec = passthrough();
    const encode = vi.spyOn(codec, 'encode');
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec,
      createSocket: () => f.socket,
    });

    stage.send({ samples: new Float32Array(4), sampleRate: 24_000 });
    expect(encode).not.toHaveBeenCalled();

    const opened = stage.open();
    f.fire('open');
    await opened;
    await stage.close();

    stage.send({ samples: new Float32Array(4), sampleRate: 24_000 });
    expect(encode).not.toHaveBeenCalled();
  });

  it('ends the event stream when the socket closes', async () => {
    const f = fakeSocket();
    const stage = new MoshiDuplexStage({
      url: 'ws://x',
      codec: passthrough(),
      createSocket: () => f.socket,
    });
    const opened = stage.open();
    f.fire('open');
    await opened;

    const drained = (async () => {
      const seen: DuplexEvent[] = [];
      for await (const e of stage.events()) seen.push(e);
      return seen;
    })();

    f.fire('close');
    expect(await drained).toEqual([]);
  });

  it('declares that it cannot measure time to first token', () => {
    // Text and audio are independent frames with no ordering guarantee, so a
    // "first token" figure here would really be "first frame of either kind".
    const stage = new MoshiDuplexStage({ url: 'ws://x', codec: passthrough() });
    expect(stage.capabilities.transcriptsLeadAudio).toBe(false);
    expect(stage.capabilities.assistantTranscripts).toBe(true);
    expect(stage.capabilities.nativeBargeIn).toBe(true);
  });
});
