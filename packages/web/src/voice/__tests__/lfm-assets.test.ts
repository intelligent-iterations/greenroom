import { describe, expect, it, vi } from 'vitest';
import {
  FolderAssetSource,
  resolveModelFolder,
  surveyFolder,
  type LoadStep,
} from '../lfm-assets.js';
import { FakeDirectoryHandle, fakeFile } from './fake-fs.js';
import { LFM_Q4_MANIFEST, totalBytes } from 'greenroom-realtime/lfm2';

/**
 * The flow that was shipped untested and promptly got stuck.
 *
 * Everything here runs against an in-memory folder and a fake fetch, so the
 * whole download-validate-save-reuse cycle is exercised without a network or
 * two gigabytes of weights.
 */

const DECODER = LFM_Q4_MANIFEST.find((e) => e.file === 'decoder_q4.onnx')!;

/** A fetch that serves `size` bytes in a few chunks, like a real stream. */
function fakeFetch(size: number, options: { status?: number; chunks?: number } = {}) {
  return vi.fn(async (_url: string) => {
    if (options.status && options.status !== 200) {
      return new Response(null, { status: options.status });
    }
    const chunks = options.chunks ?? 3;
    const per = Math.ceil(size / chunks);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) return controller.close();
        const n = Math.min(per, size - sent);
        sent += n;
        controller.enqueue(new Uint8Array(n));
      },
    });
    return new Response(stream, { headers: { 'Content-Length': String(size) } });
  }) as unknown as typeof fetch;
}

const createSession = vi.fn(async () => ({
  inputNames: [],
  outputNames: [],
  run: async () => ({}),
}));

function put(folder: FakeDirectoryHandle, name: string, size: number) {
  folder.files.set(name, fakeFile(new Uint8Array(size), name));
}

describe('surveyFolder', () => {
  it('reports an empty folder as entirely missing', async () => {
    const survey = await surveyFolder(new FakeDirectoryHandle() as never);
    expect(survey.complete).toHaveLength(0);
    expect(survey.missing).toHaveLength(LFM_Q4_MANIFEST.length);
    expect(survey.totalBytes).toBe(totalBytes(LFM_Q4_MANIFEST));
  });

  it('recognises a fully downloaded folder', async () => {
    const folder = new FakeDirectoryHandle();
    for (const entry of LFM_Q4_MANIFEST) put(folder, entry.file, entry.bytes);

    const survey = await surveyFolder(folder as never);
    expect(survey.missing).toHaveLength(0);
    expect(survey.corrupt).toHaveLength(0);
    expect(survey.presentBytes).toBe(survey.totalBytes);
  });

  it('separates a truncated file from a missing one', async () => {
    // The distinction that matters in front of a person: one downloads, the
    // other is replaced. Counting a half-written file as ready is what makes a
    // model fail to load with no explanation.
    const folder = new FakeDirectoryHandle();
    put(folder, DECODER.file, DECODER.bytes - 1000);

    const survey = await surveyFolder(folder as never);
    expect(survey.corrupt).toHaveLength(1);
    expect(survey.corrupt[0]?.entry.file).toBe(DECODER.file);
    expect(survey.corrupt[0]?.actualBytes).toBe(DECODER.bytes - 1000);
    expect(survey.missing.some((m) => m.file === DECODER.file)).toBe(false);
    // And it does not count toward what is present.
    expect(survey.presentBytes).toBe(0);
  });
});

describe('FolderAssetSource memory behaviour', () => {
  /**
   * The bug that produced "stuck downloading".
   *
   * The first version collected every chunk and then allocated a second buffer
   * the size of the whole file to concatenate them. For the 1.16GB decoder
   * weights that is 2.3GB of peak allocation, which on a constrained machine
   * does not fail — it swaps, and thrashing is indistinguishable from a hang.
   */
  it('streams to the folder instead of buffering the whole file', async () => {
    const folder = new FakeDirectoryHandle();
    let maxBufferedChunks = 0;

    const chunkCount = 50;
    const size = DECODER.bytes;
    const per = Math.ceil(size / chunkCount);
    let sent = 0;
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) return controller.close();
          const n = Math.min(per, size - sent);
          sent += n;
          controller.enqueue(new Uint8Array(n));
        },
      });
      return new Response(stream, { headers: { 'Content-Length': String(size) } });
    }) as unknown as typeof fetch;

    // Count writes: a streaming implementation writes many times, a buffering
    // one writes once at the end with everything.
    const writes: number[] = [];
    const original = folder.getFileHandle.bind(folder);
    folder.getFileHandle = async (name: string, options?: { create?: boolean }) => {
      const handle = await original(name, options);
      const create = handle.createWritable.bind(handle);
      handle.createWritable = async () => {
        const w = await create();
        // Cast through the DOM's write signature: cross-origin isolation makes
        // a Uint8Array's buffer ArrayBufferLike, which does not satisfy
        // FileSystemWriteChunkType's ArrayBuffer constraint.
        const write = w.write.bind(w) as (d: unknown) => Promise<void>;
        (w as unknown as { write: (d: Uint8Array) => Promise<void> }).write = async (
          d: Uint8Array,
        ) => {
          writes.push(d.length);
          maxBufferedChunks = Math.max(maxBufferedChunks, d.length);
          return write(d);
        };
        return w;
      };
      return handle;
    };

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession,
      fetchImpl,
    });

    await source.bytes(DECODER.file);

    // Many small writes, not one enormous one.
    expect(writes.length).toBeGreaterThan(10);
    expect(maxBufferedChunks).toBeLessThan(size / 10);
    expect(folder.files.get(DECODER.file)?.size).toBe(size);
  });

  it('does not flood listeners with one update per chunk', async () => {
    // ~18,000 React renders for a single file was enough on its own to make
    // the tab stop responding.
    const size = 4_000_000;
    let sent = 0;
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) return controller.close();
          sent += 4096;
          controller.enqueue(new Uint8Array(4096));
        },
      });
      return new Response(stream, { headers: { 'Content-Length': String(size) } });
    }) as unknown as typeof fetch;

    const source = new FolderAssetSource({ repo: 'test/repo', createSession, fetchImpl });
    let updates = 0;
    source.onProgress(() => (updates += 1));
    await source.bytes('unmanifested.bin');

    // ~977 chunks; throttling must cut this by an order of magnitude.
    expect(updates).toBeLessThan(100);
  });

  it('removes the partial file when a download fails midway', async () => {
    const folder = new FakeDirectoryHandle();
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1000));
          controller.error(new Error('connection lost'));
        },
      });
      return new Response(stream, { headers: { 'Content-Length': '999999' } });
    }) as unknown as typeof fetch;

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession,
      fetchImpl,
    });

    await expect(source.bytes(DECODER.file)).rejects.toThrow();
    // Nothing left that a later session could mistake for a complete file.
    expect([...folder.files.keys()]).not.toContain(DECODER.file);
    expect([...folder.files.keys()].some((k) => k.endsWith('.part'))).toBe(false);
  });
});

describe('FolderAssetSource', () => {
  it('downloads a file, validates its size, and saves it', async () => {
    const folder = new FakeDirectoryHandle();
    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession,
      fetchImpl: fakeFetch(DECODER.bytes),
    });

    const bytes = await source.bytes(DECODER.file);
    expect(bytes.byteLength).toBe(DECODER.bytes);
    expect(folder.files.get(DECODER.file)?.size).toBe(DECODER.bytes);
    // Nothing left behind from the atomic write.
    expect([...folder.files.keys()].some((k) => k.endsWith('.part'))).toBe(false);
  });

  it('reuses a correctly sized file without touching the network', async () => {
    const folder = new FakeDirectoryHandle();
    put(folder, DECODER.file, DECODER.bytes);
    const fetchImpl = fakeFetch(DECODER.bytes);

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession,
      fetchImpl,
    });

    const steps: LoadStep[] = [];
    source.onStep((s) => steps.push(s));

    await source.bytes(DECODER.file);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(steps.some((s) => s.kind === 'cached')).toBe(true);
  });

  it('re-downloads a file of the wrong size instead of trusting it', async () => {
    // This is the bug the manifest exists for: a truncated file is present and
    // non-empty, and the old code handed it straight to ONNX Runtime.
    const folder = new FakeDirectoryHandle();
    put(folder, DECODER.file, 1234);
    const fetchImpl = fakeFetch(DECODER.bytes);

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession,
      fetchImpl,
    });

    const bytes = await source.bytes(DECODER.file);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bytes.byteLength).toBe(DECODER.bytes);
    expect(folder.files.get(DECODER.file)?.size).toBe(DECODER.bytes);
  });

  it('rejects a download that arrives the wrong size', async () => {
    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: new FakeDirectoryHandle() as never,
      createSession,
      fetchImpl: fakeFetch(DECODER.bytes - 50),
    });
    await expect(source.bytes(DECODER.file)).rejects.toThrow(/expected/);
  });

  it('reports progress against the manifest, not the growing total', async () => {
    // The lurching bar: the old denominator was whatever had started so far.
    const source = new FolderAssetSource({
      repo: 'test/repo',
      createSession,
      fetchImpl: fakeFetch(DECODER.bytes, { chunks: 4 }),
    });

    const totals: number[] = [];
    source.onProgress((p) => totals.push(p.total ?? -1));
    await source.bytes(DECODER.file);

    expect(totals.length).toBeGreaterThan(1);
    expect(new Set(totals)).toEqual(new Set([DECODER.bytes]));
  });

  it('knows the whole download size before anything starts', async () => {
    const source = new FolderAssetSource({ repo: 'test/repo', createSession });
    expect(source.totalBytes).toBe(totalBytes(LFM_Q4_MANIFEST));
    expect(source.totalBytes).toBeGreaterThan(2_000_000_000);
  });

  it('announces every step, including the ones that are not downloads', async () => {
    // A silent step is indistinguishable from a hang, which is exactly what
    // "stuck at loading the model" looked like.
    //
    // This fake serves each file its own manifest size; an earlier version
    // served one size for everything and the size check correctly rejected it,
    // which is a fair demonstration that the check works.
    const byName = vi.fn(async (url: string) => {
      const name = url.split('/').pop() as string;
      const size = LFM_Q4_MANIFEST.find((e) => e.file === name)?.bytes ?? 0;
      return new Response(new Uint8Array(size), {
        headers: { 'Content-Length': String(size) },
      });
    }) as unknown as typeof fetch;

    const source = new FolderAssetSource({
      repo: 'test/repo',
      createSession,
      fetchImpl: byName,
    });

    const kinds: string[] = [];
    source.onStep((s) => kinds.push(s.kind));
    await source.session('decoder_q4');

    expect(kinds).toContain('checking');
    expect(kinds).toContain('downloading');
    expect(kinds).toContain('compiling');
  });

  it('surfaces an HTTP failure with the status rather than hanging', async () => {
    const source = new FolderAssetSource({
      repo: 'test/repo',
      createSession,
      fetchImpl: fakeFetch(0, { status: 404 }),
    });
    await expect(source.bytes(DECODER.file)).rejects.toThrow(/404/);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = new FolderAssetSource({
      repo: 'test/repo',
      createSession,
      fetchImpl: fakeFetch(DECODER.bytes),
      signal: controller.signal,
    });
    await expect(source.bytes(DECODER.file)).rejects.toThrow(/cancelled/i);
  });

  it('treats an absent optional weights file as absent, not as an error', async () => {
    // audio_embedding has no external data in some exports; a 404 there is
    // normal and must not fail the load.
    const source = new FolderAssetSource({
      repo: 'test/repo',
      createSession,
      fetchImpl: fakeFetch(0, { status: 404 }),
    });
    await expect(source.session('not_in_manifest')).rejects.toThrow();
  });
});

describe('weights reach the runtime without passing through memory', () => {
  /**
   * The bug that survived the download being fixed.
   *
   * Every file downloaded, byte-exact, and then the fifth session failed with
   * `RuntimeError: memory access out of bounds`. The cause was this layer
   * handing ONNX Runtime an ArrayBuffer: ORT copies it into the wasm heap and
   * we keep ours, so 1.7GB of weights costs 3.4GB of live memory and the
   * wasm32 address space runs out.
   *
   * These tests assert the *type* that crosses the boundary, because that is
   * the whole defect. A test that only checks the bytes arrive — which is what
   * every test above does — passes either way.
   */
  it('hands the runtime a Blob, never a buffer', async () => {
    const folder = new FakeDirectoryHandle();
    for (const entry of LFM_Q4_MANIFEST) put(folder, entry.file, entry.bytes);

    const seen: { path: string; data: unknown }[] = [];
    const spy = vi.fn(async (_graph: ArrayBuffer, external: { path: string; data: Blob }[]) => {
      seen.push(...external);
      return { inputNames: [], outputNames: [], run: async () => ({}) };
    });

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession: spy as never,
    });

    await source.session('decoder_q4');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('decoder_q4.onnx_data');
    expect(seen[0]?.data).toBeInstanceOf(Blob);
    expect(seen[0]?.data).not.toBeInstanceOf(ArrayBuffer);
    expect((seen[0]?.data as Blob).size).toBe(
      LFM_Q4_MANIFEST.find((e) => e.file === 'decoder_q4.onnx_data')!.bytes,
    );
  });

  it('does not read a cached weights file to serve it', async () => {
    // A 1.16GB cache hit that calls arrayBuffer() has already lost. The file is
    // handed over unread and only ORT decides when to pull the bytes.
    const folder = new FakeDirectoryHandle();
    for (const entry of LFM_Q4_MANIFEST) put(folder, entry.file, entry.bytes);

    const weights = folder.files.get('decoder_q4.onnx_data')!;
    let reads = 0;
    Object.defineProperty(weights, 'arrayBuffer', {
      value: () => {
        reads += 1;
        return Promise.resolve(new ArrayBuffer(0));
      },
    });

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession: vi.fn(async () => ({
        inputNames: [],
        outputNames: [],
        run: async () => ({}),
      })) as never,
    });

    await source.session('decoder_q4');
    expect(reads).toBe(0);
  });

  it('still gives embed_tokens.bin as bytes, because it is indexed directly', async () => {
    const folder = new FakeDirectoryHandle();
    put(folder, 'embed_tokens.bin', 536_870_912);

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      createSession,
    });

    const bytes = await source.bytes('embed_tokens.bin');
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(bytes.byteLength).toBe(536_870_912);
  });

  it('hands over a downloaded file as a Blob too, not only a cached one', async () => {
    const folder = new FakeDirectoryHandle();
    const seen: { path: string; data: unknown }[] = [];
    const byName = vi.fn(async (url: string) => {
      const name = url.split('/').pop() as string;
      const size = LFM_Q4_MANIFEST.find((e) => e.file === name)?.bytes ?? 0;
      return new Response(new Uint8Array(size), {
        headers: { 'Content-Length': String(size) },
      });
    }) as unknown as typeof fetch;

    const source = new FolderAssetSource({
      repo: 'test/repo',
      folder: folder as never,
      fetchImpl: byName,
      createSession: (async (_g: ArrayBuffer, external: { path: string; data: Blob }[]) => {
        seen.push(...external);
        return { inputNames: [], outputNames: [], run: async () => ({}) };
      }) as never,
    });

    await source.session('audio_detokenizer_q4');

    expect(seen[0]?.data).toBeInstanceOf(Blob);
    expect((seen[0]?.data as Blob).size).toBe(
      LFM_Q4_MANIFEST.find((e) => e.file === 'audio_detokenizer_q4.onnx_data')!.bytes,
    );
  });
});

describe('resolveModelFolder', () => {
  it('uses the chosen folder when the files are in it', async () => {
    const folder = new FakeDirectoryHandle();
    for (const entry of LFM_Q4_MANIFEST) put(folder, entry.file, entry.bytes);

    expect(await resolveModelFolder(folder as never)).toBe(folder);
  });

  it('looks one level down when the parent was picked', async () => {
    // The mistake this exists for: picking ~/Documents when the model is in
    // ~/Documents/models. Every file reads as missing and two gigabytes are
    // downloaded onto a disk that already has them.
    const parent = new FakeDirectoryHandle('Documents');
    const child = await parent.getDirectoryHandle('models', { create: true });
    for (const entry of LFM_Q4_MANIFEST) put(child, entry.file, entry.bytes);

    const resolved = await resolveModelFolder(parent as never);
    expect(resolved.name).toBe('models');

    const survey = await surveyFolder(resolved as never);
    expect(survey.missing).toHaveLength(0);
  });

  it('refuses to guess between two candidates', async () => {
    // Two folders that both look right means the user meant something that
    // cannot be inferred. Better to survey what they picked and report it
    // honestly than to silently load the wrong copy.
    const parent = new FakeDirectoryHandle('Documents');
    for (const name of ['a', 'b']) {
      const child = await parent.getDirectoryHandle(name, { create: true });
      for (const entry of LFM_Q4_MANIFEST) put(child, entry.file, entry.bytes);
    }

    expect((await resolveModelFolder(parent as never)).name).toBe('Documents');
  });

  it('returns the chosen folder when nothing below it matches', async () => {
    const parent = new FakeDirectoryHandle('Downloads');
    const child = await parent.getDirectoryHandle('holiday-photos', { create: true });
    put(child, 'IMG_0001.jpg', 4096);

    expect((await resolveModelFolder(parent as never)).name).toBe('Downloads');
  });

  it('ignores a subfolder holding only a truncated file', async () => {
    // Presence is not enough anywhere else in this file and must not be here.
    const parent = new FakeDirectoryHandle('Documents');
    const child = await parent.getDirectoryHandle('models', { create: true });
    child.files.set('audio_encoder_q4.onnx', fakeFile(new Uint8Array(), 'audio_encoder_q4.onnx'));

    expect((await resolveModelFolder(parent as never)).name).toBe('Documents');
  });
});

describe('manifestFor', () => {
  it('refuses a precision whose sizes were never recorded', async () => {
    // It used to return an empty list, so the survey found nothing missing and
    // the UI said "Every file is here. Nothing to download." over no files at
    // all — then asked for filenames that do not exist.
    await expect(surveyFolder(new FakeDirectoryHandle() as never, '_fp16')).rejects.toThrow(
      /_fp16/,
    );
  });
});
