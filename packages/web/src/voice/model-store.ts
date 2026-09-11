/**
 * Where downloaded models live.
 *
 * By default they go into the browser's own storage, which is invisible,
 * per-origin, and evictable — a browser under storage pressure can delete a
 * gigabyte you waited ten minutes for, and you would find out by waiting ten
 * minutes again.
 *
 * So the user can nominate a real folder instead. The same folder is then read
 * on every later run, which makes the second launch instant and offline, and
 * means the weights are yours: shared with another tool, backed up, or deleted
 * without hunting through browser settings.
 *
 * transformers.js consults `env.customCache` before the network, and that hook
 * takes both a read and a write. `local-models.ts` already implements the read
 * half for a folder the user *already* has; this is the writable version that
 * also fills the folder in the first place.
 *
 * Chromium only. `showDirectoryPicker` does not exist in Safari or Firefox, so
 * `supportsModelFolder()` gates the offer rather than presenting a choice that
 * cannot be honoured.
 */

const DB_NAME = 'greenroom.models';
const STORE = 'handles';
const KEY = 'modelFolder';

export function supportsModelFolder(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Ask for a folder. Must be called from a user gesture. */
export async function chooseModelFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  if (!supportsModelFolder()) return undefined;
  const picker = (globalThis as unknown as {
    showDirectoryPicker: (o: { mode: string; id: string }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  try {
    const handle = await picker({ mode: 'readwrite', id: 'greenroom-models' });
    await idb('readwrite', (s) => s.put(handle, KEY));
    return handle;
  } catch {
    // The user dismissed the picker. Not an error worth reporting.
    return undefined;
  }
}

/**
 * The folder from a previous visit, if it is still usable.
 *
 * Permission does not always survive a reload. When it has lapsed the handle is
 * kept and `needsPermission` is true, because the fix is one click rather than
 * choosing the folder again — and re-picking is the annoying part.
 */
export async function restoreModelFolder(): Promise<
  { handle: FileSystemDirectoryHandle; needsPermission: boolean } | undefined
> {
  if (!supportsModelFolder()) return undefined;
  let handle: FileSystemDirectoryHandle | undefined;
  try {
    handle = await idb<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(KEY));
  } catch {
    return undefined;
  }
  if (!handle) return undefined;

  const state = await queryPermission(handle);
  if (state === 'denied') {
    await forgetModelFolder();
    return undefined;
  }
  return { handle, needsPermission: state !== 'granted' };
}

/** Re-grant a lapsed permission. Must be called from a user gesture. */
export async function grantModelFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const withPermission = handle as FileSystemDirectoryHandle & {
    requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
  };
  if (!withPermission.requestPermission) return true;
  try {
    return (await withPermission.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

export async function forgetModelFolder(): Promise<void> {
  try {
    await idb('readwrite', (s) => s.delete(KEY));
  } catch {
    // Nothing to forget.
  }
}

async function queryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const withPermission = handle as FileSystemDirectoryHandle & {
    queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  };
  if (!withPermission.queryPermission) return 'granted';
  try {
    return await withPermission.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

/**
 * Where a requested URL lands inside the chosen folder.
 *
 * Hugging Face URLs look like
 * `https://host/<org>/<repo>/resolve/main/onnx/model_q4.onnx`, and the part
 * worth keeping is `<org>/<repo>/onnx/model_q4.onnx` — the same layout the
 * repositories use, so the folder stays legible and another tool can read it.
 */
export function storagePathFor(url: string): string[] {
  const { pathname } = new URL(url, 'https://huggingface.co');
  const parts = pathname.split('/').filter(Boolean);
  const resolveAt = parts.indexOf('resolve');
  const cleaned =
    resolveAt === -1 ? parts : [...parts.slice(0, resolveAt), ...parts.slice(resolveAt + 2)];
  // Never let a crafted URL escape the chosen folder.
  return cleaned.filter((p) => p !== '.' && p !== '..' && p.length > 0);
}

/**
 * A transformers.js cache backed by a real folder: reads on the way in, writes
 * on the way out.
 */
export function createFolderCache(root: FileSystemDirectoryHandle) {
  /**
   * Suffix for a file still being written.
   *
   * `match` only ever reads the final name, so an interrupted write is
   * invisible rather than corrupting. This machine kept losing processes to the
   * OOM killer mid-download, and the first version of this happily served the
   * truncated result on the next run — which presents as a broken model rather
   * than as a failed download, and is much harder to diagnose.
   */
  const PARTIAL = '.part';

  async function directoryFor(
    segments: string[],
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | undefined> {
    let dir = root;
    for (const segment of segments) {
      try {
        dir = await dir.getDirectoryHandle(segment, { create });
      } catch {
        return undefined;
      }
    }
    return dir;
  }

  return {
    async match(request: string): Promise<Response | undefined> {
      const path = storagePathFor(request);
      const name = path.pop();
      if (!name) return undefined;
      const dir = await directoryFor(path, false);
      if (!dir) return undefined;
      try {
        const file = await (await dir.getFileHandle(name)).getFile();
        // A zero-byte file is a failed write from a previous run, not a model.
        if (file.size === 0) return undefined;
        return new Response(file, {
          status: 200,
          headers: {
            'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
            'Content-Length': String(file.size),
          },
        });
      } catch {
        return undefined;
      }
    },

    async put(request: string, response: Response): Promise<void> {
      const path = storagePathFor(request);
      const name = path.pop();
      if (!name) return;

      // Read the clone to completion rather than piping it.
      //
      // `clone()` tees the body, and a tee only flows while *both* branches are
      // being read. transformers.js reads its branch after this returns, so
      // streaming ours into a file that then errors leaves the pipe waiting on
      // a sibling nobody is draining — a deadlock that presents as a download
      // which simply stops. Draining to a buffer costs one copy and cannot
      // deadlock. The bytes are already in memory at this point regardless.
      let bytes: ArrayBuffer;
      try {
        bytes = await response.clone().arrayBuffer();
      } catch {
        return;
      }
      if (bytes.byteLength === 0) return;

      let dir: FileSystemDirectoryHandle | undefined;
      try {
        dir = await directoryFor(path, true);
        if (!dir) return;

        // Written under a temporary name and renamed on success, so a crash
        // leaves a .part that nothing reads rather than a plausible-looking
        // fragment of a model.
        const partial = await dir.getFileHandle(name + PARTIAL, { create: true });
        const writable = await partial.createWritable();
        await writable.write(new Uint8Array(bytes));
        await writable.close();

        const written = (await partial.getFile()).size;
        const expected = Number(response.headers.get('Content-Length') ?? 0);
        if (written === 0 || (expected > 0 && written !== expected)) {
          await dir.removeEntry(name + PARTIAL).catch(() => {});
          return;
        }

        const movable = partial as FileSystemFileHandle & {
          move?: (name: string) => Promise<void>;
        };
        if (!movable.move) {
          // No atomic rename available. Caching here could only produce a file
          // that looks complete without being verifiable, so decline.
          await dir.removeEntry(name + PARTIAL).catch(() => {});
          return;
        }
        await movable.move(name);
      } catch {
        // Leave nothing behind that a later run could mistake for a model.
        await dir?.removeEntry(name + PARTIAL).catch(() => {});
      }
    },
  };
}
