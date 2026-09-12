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
