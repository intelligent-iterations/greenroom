/**
 * Serving models the user already has on disk.
 *
 * Re-downloading two gigabytes someone has already fetched — for Ollama, LM
 * Studio, or an earlier run of this app — is a bad first experience and, on a
 * metered connection, a real cost. transformers.js exposes a cache hook
 * (`env.useCustomCache` / `env.customCache`) that is consulted before the
 * network, so a folder the user picks can answer those requests instead.
 *
 * The browser cannot read a path; it can read a directory the user explicitly
 * hands over. `showDirectoryPicker` where available, falling back to a
 * `<input webkitdirectory>` selection. Either way the user chooses, and nothing
 * is read that they did not select.
 */

/** Files keyed by their path within the chosen folder. */
export type LocalModelFiles = Map<string, File>;

export interface LocalModelSource {
  label: string;
  files: LocalModelFiles;
}

/** Normalises a path so nested folder layouts still match a request. */
function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Matches a requested URL against the files the user provided.
 *
 * transformers.js asks for full URLs like
 * `https://huggingface.co/<repo>/resolve/main/onnx/model_q4f16.onnx`. What
 * matters is the tail, because the folder on disk rarely mirrors the repo
 * layout above `onnx/`. Longest suffix wins, so `onnx/model_q4f16.onnx` is
 * preferred over a bare `model_q4f16.onnx` when both are present.
 */
export function findLocalFile(files: LocalModelFiles, request: string): File | undefined {
  const wanted = normalise(new URL(request, 'https://example.invalid').pathname);
  let best: { file: File; score: number } | undefined;

  for (const [path, file] of files) {
    const candidate = normalise(path);
    if (!wanted.endsWith(candidate) && !candidate.endsWith(wanted.split('/').pop() ?? '')) continue;

    // Prefer the match that agrees with more of the requested path.
    const score = candidate.length;
    if (!best || score > best.score) best = { file, score };
  }

  return best?.file;
}

/**
 * A transformers.js cache backed by user-selected files.
 *
 * `match` returning undefined falls through to the network, so a partial
 * folder still works: whatever is present is served locally and the rest is
 * downloaded. That matters because model folders in the wild are rarely
 * complete in the way this pipeline expects.
 */
export function createLocalCache(files: LocalModelFiles) {
  return {
    async match(request: string): Promise<Response | undefined> {
      const file = findLocalFile(files, request);
      if (!file) return undefined;
      return new Response(file, {
        status: 200,
        headers: {
          'Content-Type': request.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Content-Length': String(file.size),
        },
      });
    },
    // Nothing is written back: these are the user's files, and a cache that
    // wrote into them would be modifying a folder we were only lent.
    async put(): Promise<void> {},
  };
}

export function supportsDirectoryPicker(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Reads a directory the user chooses, recursively. */
export async function pickModelDirectory(): Promise<LocalModelSource | undefined> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) return undefined;

  const root = await picker.call(window);
  const files: LocalModelFiles = new Map();

  async function walk(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'file') {
        files.set(path, await (handle as FileSystemFileHandle).getFile());
      } else {
        await walk(handle as FileSystemDirectoryHandle, path);
      }
    }
  }

  await walk(root, '');
  return { label: root.name, files };
}

/** Fallback for browsers without the directory picker. */
export function filesFromInput(list: FileList): LocalModelSource {
  const files: LocalModelFiles = new Map();
  for (const file of Array.from(list)) {
    // webkitRelativePath preserves the folder structure the user selected.
    files.set((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file);
  }
  const first = Array.from(list)[0] as (File & { webkitRelativePath?: string }) | undefined;
  return { label: first?.webkitRelativePath?.split('/')[0] ?? 'selected files', files };
}

/** Files that must be present for a folder to be a usable model. */
const REQUIRED = ['config.json', 'tokenizer.json'];

export interface LocalModelCheck {
  usable: boolean;
  missing: string[];
  weightFiles: string[];
}

/**
 * Tells the user whether a folder will actually work, before they start.
 *
 * A folder that looks like a model but lacks a tokenizer fails deep inside the
 * loader with a message about a missing file, minutes in. This says so up
 * front, which is the same reason `pnpm preflight` exists for the network path.
 */
export function inspectLocalModel(files: LocalModelFiles): LocalModelCheck {
  const names = [...files.keys()].map((p) => normalise(p));
  const missing = REQUIRED.filter((r) => !names.some((n) => n.endsWith(r)));
  const weightFiles = [...files.keys()].filter((p) => p.toLowerCase().endsWith('.onnx'));
  return { usable: missing.length === 0 && weightFiles.length > 0, missing, weightFiles };
}
