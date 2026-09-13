/**
 * An in-memory File System Access API, enough to exercise the model store.
 *
 * The real one needs a user gesture and a real disk, so the write path went out
 * untested and broke a download. This is the fake that should have existed
 * first.
 */
/**
 * A real File, not a stand-in.
 *
 * The production code does `new Response(file)`, and a plain object there
 * serialises to "[object Object]" — so a fake that is merely File-shaped
 * produces a passing-looking test that proves nothing about the bytes.
 */
export function fakeFile(bytes: Uint8Array, name = 'f'): File {
  return new File([bytes as unknown as BlobPart], name);
}

/**
 * The real `createWritable()` returns a FileSystemWritableFileStream: a
 * WritableStream that *also* exposes write() / close() / seek() directly.
 *
 * Two earlier versions of this fake got that wrong in different ways — first a
 * plain object with a write method, which made pipeTo serialise
 * "[object Object]", then a bare WritableStream, which has no write() at all.
 * Both produced failures that looked like bugs in the code under test.
 */
function fakeWritable(
  onClose: (bytes: Uint8Array) => void,
  failAfter?: number,
): FileSystemWritableFileStream {
  const chunks: Uint8Array[] = [];
  let written = 0;

  const accept = (chunk: Uint8Array): void => {
    if (failAfter !== undefined && written + chunk.length > failAfter) {
      throw new Error('disk full');
    }
    chunks.push(chunk);
    written += chunk.length;
  };

  const finish = (): void => {
    const out = new Uint8Array(written);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    onClose(out);
  };

  const stream = new WritableStream<Uint8Array>({
    write: accept,
    close: finish,
  }) as WritableStream<Uint8Array> & {
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  };

  // The convenience surface the real stream adds on top of WritableStream.
  stream.write = async (data: Uint8Array) => accept(data);
  stream.close = async () => finish();

  return stream as unknown as FileSystemWritableFileStream;
}

export class FakeFileHandle {
  readonly kind = 'file' as const;

  constructor(
    public name: string,
    private dir: FakeDirectoryHandle,
  ) {}

  async getFile(): Promise<File> {
    const file = this.dir.files.get(this.name);
    if (!file) throw new Error('not found');
    return file;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    // A real writable does not publish until close(), which is the property
    // that makes an interrupted write invisible rather than corrupting.
    return fakeWritable(
      (bytes) => this.dir.files.set(this.name, fakeFile(bytes, this.name)),
      this.dir.failWritesAfter,
    );
  }

  async move(newName: string): Promise<void> {
    if (this.dir.supportsMove === false) throw new Error('move unsupported');
    const file = this.dir.files.get(this.name);
    if (!file) throw new Error('not found');
    this.dir.files.delete(this.name);
    this.dir.files.set(newName, file);
    this.name = newName;
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  files = new Map<string, File>();
  dirs = new Map<string, FakeDirectoryHandle>();
  supportsMove: boolean | undefined = true;
  failWritesAfter: number | undefined;

  constructor(public name = 'models') {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectoryHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new Error('not found');
      dir = new FakeDirectoryHandle(name);
      dir.supportsMove = this.supportsMove;
      dir.failWritesAfter = this.failWritesAfter;
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (!options?.create) throw new Error('not found');
      this.files.set(name, fakeFile(new Uint8Array(), name));
    }
    return new FakeFileHandle(name, this);
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }

  /**
   * Enumerate children, as the real handle does.
   *
   * Yields the handles themselves — `values()` returns FileSystemHandle
   * objects, so a caller that narrows on `kind` and then uses the result as a
   * directory is doing the right thing and must be able to.
   */
  async *values(): AsyncIterableIterator<FakeDirectoryHandle | FakeFileHandle> {
    for (const name of this.files.keys()) yield new FakeFileHandle(name, this);
    for (const dir of this.dirs.values()) yield dir;
  }

  /** Every file below this directory, as `a/b/c.onnx`. */
  walk(prefix = ''): string[] {
    return [
      ...[...this.files.keys()].map((f) => `${prefix}${f}`),
      ...[...this.dirs.entries()].flatMap(([n, d]) => d.walk(`${prefix}${n}/`)),
    ];
  }
}
