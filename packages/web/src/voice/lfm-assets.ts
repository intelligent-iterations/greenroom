import type { AssetProgress, AssetSource, SessionLike } from 'greenroom-realtime/lfm2';

/**
 * Where a 2GB model lives between sessions.
 *
 * The whole premise of an on-device model is that you pay for it once. Browser
 * storage cannot promise that — it is best-effort and a browser short of space
 * will reclaim the largest bucket it can find, which is exactly this one. That
 * is not hypothetical: it is the bug that made this app re-download its weights
 * on every visit until `storage.ts` was written.
 *
 * So a folder the person chooses is the default here rather than a power-user
 * option. Files in it are ordinary files: visible, backed up, survivable, and
 * still there when the same folder is picked again on another machine or after
 * clearing site data. On a second session the app asks for that folder back,
 * finds the weights already present, and downloads nothing.
 *
 * Anything missing falls through to the network and is written into the folder
 * as it arrives, so a partial folder is fine and an interrupted download costs
 * only what it had not yet fetched.
 */

export interface LfmAssetOptions {
  /** Hugging Face repo, e.g. LiquidAI/LFM2.5-Audio-1.5B-ONNX. */
  repo: string;
  /** Where to keep the files. Omitted means network every time. */
  folder?: FileSystemDirectoryHandle;
  /** Creates an ONNX session. Injected so this file never imports onnxruntime. */
  createSession(graph: ArrayBuffer, externalData: { path: string; data: ArrayBuffer }[]): Promise<SessionLike>;
}

export class FolderAssetSource implements AssetSource {
  #options: LfmAssetOptions;
  #listeners: ((progress: AssetProgress) => void)[] = [];

  constructor(options: LfmAssetOptions) {
    this.#options = options;
  }

  onProgress(listener: (progress: AssetProgress) => void): void {
    this.#listeners.push(listener);
  }

  #report(progress: AssetProgress): void {
    for (const listener of this.#listeners) listener(progress);
  }

  async session(name: string): Promise<SessionLike> {
    const graph = await this.bytes(`${name}.onnx`);
    // Weights live beside the graph as external data. ORT needs them supplied
    // by the exact filename the graph refers to, not by path.
    const data = await this.#maybeBytes(`${name}.onnx_data`);
    const externalData = data ? [{ path: `${name}.onnx_data`, data }] : [];
    return this.#options.createSession(graph, externalData);
  }

  async bytes(name: string): Promise<ArrayBuffer> {
    const found = await this.#maybeBytes(name);
    if (!found) throw new Error(`${name} could not be fetched`);
    return found;
  }

  async #maybeBytes(name: string): Promise<ArrayBuffer | undefined> {
    const cached = await this.#readFolder(name);
    if (cached) {
      this.#report({ file: name, loaded: cached.byteLength, total: cached.byteLength, cached: true });
      return cached;
    }

    const url = `https://huggingface.co/${this.#options.repo}/resolve/main/onnx/${name}`;
    const response = await fetch(url);
    if (!response.ok) return undefined;

    const bytes = await this.#download(response, name);
    await this.#writeFolder(name, bytes);
    return bytes;
  }

  /** Streams so progress is real rather than a spinner that jumps to 100%. */
  async #download(response: Response, name: string): Promise<ArrayBuffer> {
    const total = Number(response.headers.get('Content-Length') ?? 0) || undefined;
    const reader = response.body?.getReader();
    if (!reader) return response.arrayBuffer();

    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      this.#report({ file: name, loaded, ...(total !== undefined ? { total } : {}) });
    }

    const out = new Uint8Array(loaded);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out.buffer;
  }

  async #readFolder(name: string): Promise<ArrayBuffer | undefined> {
    const folder = this.#options.folder;
    if (!folder) return undefined;
    try {
      const handle = await folder.getFileHandle(name);
      const file = await handle.getFile();
      // A zero-byte file is the fingerprint of an interrupted write. Treating it
      // as a hit would hand ORT an empty graph and fail somewhere far from here.
      if (file.size === 0) return undefined;
      return await file.arrayBuffer();
    } catch {
      return undefined;
    }
  }

  /**
   * Write to a `.part` name, verify, then rename.
   *
   * A download interrupted halfway through — a closed tab, a lost network, a
   * process the OS killed — would otherwise leave a truncated file that the next
   * session reads as complete. That failure presents as a corrupt model rather
   * than a missing one, which is far harder to diagnose.
   */
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
        // Without an atomic rename there is no way to publish the file safely,
        // so decline to cache rather than store something unverifiable.
        await folder.removeEntry(temporary).catch(() => {});
        return;
      }
      await movable.move(name);
    } catch {
      await folder.removeEntry(temporary).catch(() => {});
    }
  }
}

/** Every file the stage will ask for, so a UI can report what is already present. */
export function lfmFileNames(suffix = '_q4'): string[] {
  const graphs = [
    'audio_encoder',
    'decoder',
    'vocoder_depthformer',
    'audio_detokenizer',
    'audio_embedding',
  ];
  return [...graphs.flatMap((g) => [`${g}${suffix}.onnx`, `${g}${suffix}.onnx_data`]), 'embed_tokens.bin'];
}

/** How much of the model is already in a folder — drives "already downloaded". */
export async function surveyFolder(
  folder: FileSystemDirectoryHandle,
  suffix = '_q4',
): Promise<{ present: string[]; missing: string[]; bytes: number }> {
  const present: string[] = [];
  const missing: string[] = [];
  let bytes = 0;

  for (const name of lfmFileNames(suffix)) {
    try {
      const file = await (await folder.getFileHandle(name)).getFile();
      if (file.size > 0) {
        present.push(name);
        bytes += file.size;
        continue;
      }
      missing.push(name);
    } catch {
      missing.push(name);
    }
  }

  return { present, missing, bytes };
}
