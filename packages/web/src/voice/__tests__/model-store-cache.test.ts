import { describe, expect, it } from 'vitest';
import { createFolderCache } from '../model-store.js';
import { FakeDirectoryHandle } from './fake-fs.js';

const URL_A = 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder.onnx';
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function responseOf(bytes: Uint8Array): Response {
  // A Blob, not the Uint8Array itself: `new Response(uint8)` stringifies it to
  // "[object Object]", which is how the first version of this test managed to
  // fail for a reason that had nothing to do with the code under test.
  return new Response(new Blob([bytes as unknown as BlobPart]), {
    headers: { 'Content-Length': String(bytes.length) },
  });
}

function cacheOn(root: FakeDirectoryHandle) {
  return createFolderCache(root as unknown as FileSystemDirectoryHandle);
}

describe('folder cache round trip', () => {
  it('stores a file and reads the same bytes back', async () => {
    const root = new FakeDirectoryHandle();
    const cache = cacheOn(root);

    await cache.put(URL_A, responseOf(BYTES));
    const hit = await cache.match(URL_A);

    expect(hit).toBeDefined();
    expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(BYTES);
  });

  it('lays the folder out like the repository, so other tools can read it', async () => {
    const root = new FakeDirectoryHandle();
    await cacheOn(root).put(URL_A, responseOf(BYTES));
    expect(root.walk()).toEqual(['onnx-community/whisper-base/onnx/encoder.onnx']);
  });

  it('misses for something never stored', async () => {
    expect(await cacheOn(new FakeDirectoryHandle()).match(URL_A)).toBeUndefined();
  });
});

describe('folder cache under failure', () => {
  /**
   * The bug that matters most, and the one this machine kept producing: the
   * process dies partway through a gigabyte. A partial file served as a
   * complete one is worse than re-downloading — the model loads corrupt, or
   * fails in a way that looks like a model problem.
   */
  it('does not serve a partially written file', async () => {
    const root = new FakeDirectoryHandle();
    root.failWritesAfter = 4; // die four bytes into eight
    const cache = cacheOn(root);

    await cache.put(URL_A, responseOf(BYTES));
    const hit = await cache.match(URL_A);

    expect(hit, 'a truncated write must not become a cache hit').toBeUndefined();
  });

  it('leaves no partial file behind for the next run to find', async () => {
    const root = new FakeDirectoryHandle();
    root.failWritesAfter = 4;
    await cacheOn(root).put(URL_A, responseOf(BYTES));
    expect(root.walk().filter((f) => !f.endsWith('.part'))).toEqual([]);
  });

  /**
   * A body-less response used to leave a zero-byte file that `match` then
   * served happily. The `?.` on `response.body` short-circuited and the
   * writable was never closed.
   */
  it('never turns an empty response into a zero-byte cache hit', async () => {
    const root = new FakeDirectoryHandle();
    const cache = cacheOn(root);

    await cache.put(URL_A, new Response(null));
    expect(await cache.match(URL_A)).toBeUndefined();
  });

  it('declines to cache rather than risk corruption when atomic rename is unavailable', async () => {
    const root = new FakeDirectoryHandle();
    root.supportsMove = false;
    const cache = cacheOn(root);

    await cache.put(URL_A, responseOf(BYTES));
    // Either it stored it safely or it stored nothing. What it must never do
    // is leave something that looks complete and is not.
    const hit = await cache.match(URL_A);
    if (hit) expect(new Uint8Array(await hit.arrayBuffer())).toEqual(BYTES);
  });

  it('does not consume the response the caller still needs', async () => {
    const root = new FakeDirectoryHandle();
    const response = responseOf(BYTES);
    await cacheOn(root).put(URL_A, response);
    // transformers.js reads the body after handing it to the cache.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });
});
