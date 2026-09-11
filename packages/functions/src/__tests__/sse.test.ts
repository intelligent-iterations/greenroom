import { describe, expect, it } from 'vitest';
import { readSseData } from '../providers/types.js';

/** Emits the given strings as a byte stream, one chunk each. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of readSseData(stream)) out.push(payload);
  return out;
}

describe('readSseData', () => {
  it('reads complete frames', async () => {
    expect(await collect(streamOf(['data: one\n\ndata: two\n\n']))).toEqual(['one', 'two']);
  });

  it('reassembles a frame split across network chunks', async () => {
    // The case a naive line-split drops: the payload straddles the boundary.
    expect(await collect(streamOf(['data: hel', 'lo\n\n']))).toEqual(['hello']);
  });

  it('ignores comment and event lines', async () => {
    expect(await collect(streamOf([': keepalive\n\nevent: ping\ndata: real\n\n']))).toEqual(['real']);
  });

  it('drops a trailing frame that never terminated', async () => {
    // Deliberate: a half-received JSON payload would fail to parse anyway, and
    // yielding it would surface a parse error instead of a clean end of stream.
    expect(await collect(streamOf(['data: complete\n\ndata: partial']))).toEqual(['complete']);
  });

  it('handles an empty stream', async () => {
    expect(await collect(streamOf([]))).toEqual([]);
  });
});
