import {
  expectedBytes,
  manifestFor,
  totalBytes,
  type AssetProgress,
  type AssetSource,
  type FolderSurvey,
  type ManifestEntry,
  type SessionLike,
} from 'greenroom-realtime/lfm2';

/**
 * Where a 2GB model lives between sessions, and how we know it arrived intact.
 *
 * The first version of this trusted a file because it existed and reported
 * progress against a total it discovered as it went. Both were wrong in ways
 * that only show up on a real 2GB download: a truncated file was handed to ONNX
 * Runtime and failed far from the cause, and the progress bar lurched because
 * its denominator grew alongside its numerator.
 *
 * Everything here is now judged against a manifest of exact sizes, and every
 * step reports — including the ones that are not downloads, because a silent
 * step is indistinguishable from a hang, and "stuck at loading the model" is
 * precisely what a person sees when a stage forgets to say it started.
 */

export type LoadStep =
  | { kind: 'checking'; file: string }
  | { kind: 'downloading'; file: string; loaded: number; total: number }
  | { kind: 'cached'; file: string; bytes: number }
  | { kind: 'saving'; file: string }
  | { kind: 'compiling'; file: string }
  | { kind: 'failed'; file: string; reason: string };

export interface LfmAssetOptions {
  repo: string;
  suffix?: string;
  folder?: FileSystemDirectoryHandle;
  createSession(
    graph: ArrayBuffer,
    externalData: { path: string; data: ArrayBuffer }[],
  ): Promise<SessionLike>;
  signal?: AbortSignal;
  /** Injectable so the whole flow is testable without a network. */
  fetchImpl?: typeof fetch;
}

export class FolderAssetSource implements AssetSource {
  #options: LfmAssetOptions;
  #listeners: ((progress: AssetProgress) => void)[] = [];
  #steps: ((step: LoadStep) => void)[] = [];
  #manifest: ManifestEntry[];

  constructor(options: LfmAssetOptions) {
    this.#options = options;
    this.#manifest = manifestFor(options.suffix ?? '_q4');
  }

  get totalBytes(): number {
    return totalBytes(this.#manifest);
  }

  onProgress(listener: (progress: AssetProgress) => void): void {
    this.#listeners.push(listener);
  }

  onStep(listener: (step: LoadStep) => void): void {
    this.#steps.push(listener);
  }

  #report(progress: AssetProgress): void {
    for (const listener of this.#listeners) listener(progress);
  }

  #step(step: LoadStep): void {
    for (const listener of this.#steps) listener(step);
  }

  async session(name: string): Promise<SessionLike> {
    const graph = await this.bytes(`${name}.onnx`);
    const data = await this.#maybeBytes(`${name}.onnx_data`);
    // Compiling a 1.2GB graph takes real time on a laptop. Announced, because
    // otherwise this is a silent minute that reads as a freeze.
    this.#step({ kind: 'compiling', file: name });
    return this.#options.createSession(graph, data ? [{ path: `${name}.onnx_data`, data }] : []);
  }

  async bytes(name: string): Promise<ArrayBuffer> {
    const found = await this.#maybeBytes(name);
    if (!found) throw new Error(`${name} could not be fetched`);
    return found;
  }

  async #maybeBytes(name: string): Promise<ArrayBuffer | undefined> {
    this.#throwIfAborted();
    const expected = expectedBytes(this.#manifest, name);

    this.#step({ kind: 'checking', file: name });
    const cached = await this.#readFolder(name, expected);
    if (cached) {
      this.#step({ kind: 'cached', file: name, bytes: cached.byteLength });
      this.#report({
        file: name,
        loaded: cached.byteLength,
        total: cached.byteLength,
        cached: true,
      });
      return cached;
    }

    const url = `https://huggingface.co/${this.#options.repo}/resolve/main/onnx/${name}`;
    const doFetch = this.#options.fetchImpl ?? fetch;
    const response = await doFetch(url, { ...(this.#options.signal ? { signal: this.#options.signal } : {}) });
    if (!response.ok) {
      // A missing optional file (not every graph has external weights) is not
      // an error; a missing manifest file is.
      if (expected === undefined) return undefined;
      this.#step({ kind: 'failed', file: name, reason: `HTTP ${response.status}` });
      throw new Error(`${name}: HTTP ${response.status}`);
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await this.#downloadStreaming(response, name, expected);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#step({ kind: 'failed', file: name, reason });
      throw error;
    }

    if (expected !== undefined && bytes.byteLength !== expected) {
      this.#step({
        kind: 'failed',
        file: name,
        reason: `expected ${expected} bytes, received ${bytes.byteLength}`,
      });
      throw new Error(`${name} downloaded ${bytes.byteLength} bytes, expected ${expected}`);
    }

    // Already written by the streaming path when a folder is available.
    if (!this.#options.folder) await this.#writeFolder(name, bytes);
    return bytes;
  }

  /**
   * Stream the body to disk, then read it back once.
   *
   * The obvious implementation — collect every chunk, concatenate, return the
   * buffer, write it — holds the file **twice** at its widest point. For the
   * 1.16GB decoder weights that is 2.3GB of peak allocation before anything is
   * saved, and on a machine with less headroom than that it does not fail. It
   * swaps, and a download that is thrashing is indistinguishable from one that
   * has hung. That is what "stuck downloading" was.
   *
   * Writing each chunk straight through keeps the peak at one chunk. Reading
   * the finished file back costs the file once, which is unavoidable: ONNX
   * Runtime takes external weights as an in-memory buffer.
   */
  async #downloadStreaming(
    response: Response,
    name: string,
    expected?: number,
  ): Promise<ArrayBuffer> {
    const declared = Number(response.headers.get('Content-Length') ?? 0) || undefined;
    const total = expected ?? declared;
    const reader = response.body?.getReader();
    if (!reader) return response.arrayBuffer();

    const folder = this.#options.folder;
    const temporary = `${name}.part`;
    let writable: FileSystemWritableFileStream | undefined;
    let handle: FileSystemFileHandle | undefined;

    if (folder) {
      try {
        handle = await folder.getFileHandle(temporary, { create: true });
        writable = await handle.createWritable();
      } catch {
        // No writable folder: fall back to buffering, which is correct but
        // costs memory. Small files are fine; the large ones want the folder.
        writable = undefined;
      }
    }

    const buffered: Uint8Array[] = [];
    let loaded = 0;
    let lastReport = 0;

    try {
      for (;;) {
        this.#throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;

        if (writable) await writable.write(value);
        else buffered.push(value);
        loaded += value.length;

        // Throttled. Reporting every chunk is ~18,000 updates for this file,
        // each one a React render — enough on its own to make the tab stop
        // responding, which also reads as stuck.
        const now = performance.now();
        if (now - lastReport > 120 || loaded === total) {
          lastReport = now;
          this.#step({ kind: 'downloading', file: name, loaded, total: total ?? loaded });
          this.#report({ file: name, loaded, ...(total !== undefined ? { total } : {}) });
        }
      }
    } catch (error) {
      await writable?.close().catch(() => {});
      if (folder) await folder.removeEntry(temporary).catch(() => {});
      throw error;
    }

    // A final report so the bar always reaches the end of this file.
    this.#report({ file: name, loaded, ...(total !== undefined ? { total } : {}) });

    if (!writable) {
      const out = new Uint8Array(loaded);
      let at = 0;
      for (const chunk of buffered) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out.buffer;
    }

    await writable.close();
    this.#step({ kind: 'saving', file: name });

    const written = await handle!.getFile();
    if (expected !== undefined && written.size !== expected) {
      await folder!.removeEntry(temporary).catch(() => {});
      throw new Error(`${name} downloaded ${written.size} bytes, expected ${expected}`);
    }

    const movable = handle as FileSystemFileHandle & { move?: (to: string) => Promise<void> };
    if (!movable.move) {
      // Without an atomic rename the file cannot be published safely, so it is
      // returned but not kept — correct this run, downloaded again the next.
      const bytes = await written.arrayBuffer();
      await folder!.removeEntry(temporary).catch(() => {});
      return bytes;
    }

    await movable.move(name);
    return (await handle!.getFile()).arrayBuffer();
  }

  /** A folder hit must be the right size, not merely present and non-empty. */
  async #readFolder(name: string, expected?: number): Promise<ArrayBuffer | undefined> {
    const folder = this.#options.folder;
    if (!folder) return undefined;
    try {
      const file = await (await folder.getFileHandle(name)).getFile();
      if (file.size === 0) return undefined;
      if (expected !== undefined && file.size !== expected) return undefined;
      return await file.arrayBuffer();
    } catch {
      return undefined;
    }
  }

  async #writeFolder(name: string, bytes: ArrayBuffer): Promise<void> {
    const folder = this.#options.folder;
    if (!folder || bytes.byteLength === 0) return;

    const temporary = `${name}.part`;
    try {
      const handle = await folder.getFileHandle(temporary, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();

      if ((await handle.getFile()).size !== bytes.byteLength) {
        await folder.removeEntry(temporary).catch(() => {});
        return;
      }

      const movable = handle as FileSystemFileHandle & { move?: (to: string) => Promise<void> };
      if (!movable.move) {
        await folder.removeEntry(temporary).catch(() => {});
        return;
      }
      await movable.move(name);
    } catch {
      await folder.removeEntry(temporary).catch(() => {});
    }
  }

  #throwIfAborted(): void {
    if (this.#options.signal?.aborted) throw new DOMException('Load cancelled', 'AbortError');
  }
}

/**
 * What a folder already holds, checked against the manifest.
 *
 * This is what makes a second session honest. Existence is not enough — a
 * half-written file would otherwise be counted as ready and the download would
 * be skipped for something that cannot load.
 */
export async function surveyFolder(
  folder: FileSystemDirectoryHandle,
  suffix = '_q4',
): Promise<FolderSurvey> {
  const manifest = manifestFor(suffix);
  const complete: ManifestEntry[] = [];
  const missing: ManifestEntry[] = [];
  const corrupt: { entry: ManifestEntry; actualBytes: number }[] = [];
  let presentBytes = 0;

  for (const entry of manifest) {
    try {
      const file = await (await folder.getFileHandle(entry.file)).getFile();
      if (file.size === entry.bytes) {
        complete.push(entry);
        presentBytes += file.size;
      } else {
        corrupt.push({ entry, actualBytes: file.size });
      }
    } catch {
      missing.push(entry);
    }
  }

  return { complete, missing, corrupt, presentBytes, totalBytes: totalBytes(manifest) };
}
