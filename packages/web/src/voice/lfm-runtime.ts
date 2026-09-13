import * as ort from 'onnxruntime-web/webgpu';
import type { SessionLike, TensorFactory, TensorLike } from 'greenroom-realtime/lfm2';

/**
 * Binding the package's runtime interface to onnxruntime-web.
 *
 * `greenroom-realtime` never imports ORT — it declares the shape it needs so the
 * generation loop can be tested without a GPU. This is the one file that knows
 * about the real thing, and it is deliberately thin: everything interesting
 * happens in the package, where it is covered by tests.
 */

/**
 * Single-threaded WASM, deliberately.
 *
 * This page is cross-origin isolated, so ONNX Runtime picks the threaded build
 * and defaults to one worker per core. Combined with the WebGPU execution
 * provider's JSEP glue that deadlocks: `InferenceSession.create` never
 * resolves, never rejects, and never logs. Observed here as a session that sat
 * for seventeen minutes on a 139MB encoder while the UI honestly reported
 * "compiling" the whole time.
 *
 * LiquidAI's own WebGPU reference sets this to 1 before creating any session.
 * It is not a performance knob for this workload — the tensor maths runs on the
 * GPU, and the WASM side is glue.
 *
 * Set at module scope so it cannot be missed by a code path that creates a
 * session without going through `createSession`.
 */
ort.env.wasm.numThreads = 1;

/**
 * How long a session may take to compile before we say something is wrong.
 *
 * Large graphs genuinely take tens of seconds on a laptop GPU, so this is not a
 * failure threshold — nothing is aborted. It exists because a silent wait is
 * indistinguishable from a hang, and that ambiguity cost a long debugging
 * session.
 */
const SLOW_COMPILE_MS = 45_000;

export const tensorFactory: TensorFactory = (type, data, dims) =>
  new ort.Tensor(type, data as never, dims as number[]) as unknown as TensorLike;

/**
 * Create a session from bytes already in hand.
 *
 * Bytes rather than a URL, because the whole point of the folder store is that
 * the weights may never have touched the network this run. ORT accepts external
 * data as in-memory buffers, which is what makes a folder-backed model possible
 * at all.
 */
export async function createSession(
  graph: ArrayBuffer,
  externalData: { path: string; data: ArrayBuffer }[],
  onSlow?: (elapsedMs: number) => void,
): Promise<SessionLike> {
  const slow = setTimeout(() => onSlow?.(SLOW_COMPILE_MS), SLOW_COMPILE_MS);
  try {
    return await create(graph, externalData);
  } finally {
    clearTimeout(slow);
  }
}

async function create(
  graph: ArrayBuffer,
  externalData: { path: string; data: ArrayBuffer }[],
): Promise<SessionLike> {
  const session = await ort.InferenceSession.create(new Uint8Array(graph), {
    executionProviders: ['webgpu'],
    ...(externalData.length > 0
      ? {
          externalData: externalData.map((e) => ({
            path: e.path,
            data: new Uint8Array(e.data),
          })),
        }
      : {}),
  } as ort.InferenceSession.SessionOptions);

  return {
    inputNames: session.inputNames,
    outputNames: session.outputNames,
    run: async (feeds) =>
      (await session.run(feeds as unknown as ort.InferenceSession.FeedsType)) as unknown as Record<
        string,
        TensorLike
      >,
    release: () => session.release(),
  };
}

/**
 * WebGPU is required, and the failure is worth naming precisely.
 *
 * A 1.5B model on the WASM backend is not slow, it is unusable — minutes per
 * reply. Refusing up front with a reason beats appearing to work.
 */
export async function requireWebGpu(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) {
    return {
      ok: false,
      reason:
        'This browser has no WebGPU. Chrome or Edge 121+ on a machine with a GPU can run it; ' +
        'in older builds it is behind chrome://flags/#enable-unsafe-webgpu.',
    };
  }
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'WebGPU is present but no adapter was available.' };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `WebGPU failed to start: ${String(error)}` };
  }
}
