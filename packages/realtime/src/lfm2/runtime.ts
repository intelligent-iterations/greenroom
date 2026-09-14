/**
 * The slice of ONNX Runtime this package uses.
 *
 * Declared as an interface rather than imported, for three reasons that all
 * matter here. onnxruntime-web is a multi-megabyte dependency that a consumer
 * may already have, and shipping a second copy is how a browser bundle doubles.
 * The build differs by target — `onnxruntime-web/webgpu` in a browser,
 * `onnxruntime-node` on a server — and that is the caller's decision. And most
 * practically: an interface can be faked, so the generation loop is testable
 * without a GPU and without 2GB of weights.
 */

export type TensorData = Float32Array | BigInt64Array | Int32Array | Uint8Array;

export interface TensorLike {
  readonly type: string;
  readonly data: TensorData;
  readonly dims: readonly number[];
  /**
   * Release the tensor's backing buffer.
   *
   * Present on onnxruntime-web tensors and absent on a plain test double,
   * hence optional. It matters more than it looks: with the WebGPU provider a
   * tensor holds a GPU buffer, and one spoken turn runs the depthformer a few
   * thousand times. Left undisposed, those accumulate until the heap gives out
   * — reported as `RuntimeError: memory access out of bounds`, a long way from
   * the loop that allocated them.
   */
  dispose?(): void;
}

export interface SessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
  release?(): Promise<void>;
}

/** Creates a tensor. Supplied by the caller so this package never imports ORT. */
export type TensorFactory = (
  type: 'float32' | 'int64' | 'int32',
  data: TensorData,
  dims: readonly number[],
) => TensorLike;

/**
 * Where the weights come from.
 *
 * Deliberately not "a URL". The whole point of a 2GB model is that it is
 * downloaded once and then found again, so the caller decides whether a file
 * comes from a directory the user picked, from the browser's cache, or from the
 * network. This package only asks.
 */
export interface AssetSource {
  /** An ONNX graph plus its external weights, ready to run. */
  session(name: string): Promise<SessionLike>;
  /** A raw file, such as embed_tokens.bin. */
  bytes(name: string): Promise<ArrayBuffer>;
  /** Optional progress while the above are fetched. */
  onProgress?(listener: (progress: AssetProgress) => void): void;
}

export interface AssetProgress {
  file: string;
  loaded: number;
  total?: number;
  /** True when the file was already on disk and nothing was downloaded. */
  cached?: boolean;
}
