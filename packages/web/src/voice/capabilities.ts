/**
 * Runtime capability detection.
 *
 * Every on-device decision in the app keys off this. Detection is done once and
 * cached because `requestAdapter()` is genuinely slow on some Linux/Mesa
 * configurations and we call it from three places.
 */

export interface DeviceCapabilities {
  hasWebGpu: boolean;
  hasSharedArrayBuffer: boolean;
  hasWebSpeechSynthesis: boolean;
  /** Physical cores, floored at 2. Used to size the ORT WASM thread pool. */
  threads: number;
  /** Best-effort GPU description, for the diagnostics panel. */
  gpuDescription?: string;
  /**
   * Largest single GPU buffer the adapter permits, in MB.
   *
   * Used as the memory budget proxy for model selection. WebGPU deliberately
   * exposes no total-VRAM figure — it would be a fingerprinting vector — so
   * this is the closest honest signal available, and it is a real constraint in
   * its own right: model weights are allocated as buffers, so a model whose
   * weights exceed this limit cannot load regardless of how much memory the
   * device actually has.
   */
  maxBufferMb?: number;
}

let cached: DeviceCapabilities | undefined;

export async function detectCapabilities(): Promise<DeviceCapabilities> {
  if (cached) return cached;

  let hasWebGpu = false;
  let gpuDescription: string | undefined;
  let maxBufferMb: number | undefined;

  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        hasWebGpu = true;
        // `info` is not in every browser's typings yet but is widely shipped.
        const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
        gpuDescription = info ? [info.vendor, info.architecture].filter(Boolean).join(' ') : 'WebGPU';
        maxBufferMb = Math.floor(Number(adapter.limits.maxBufferSize) / (1024 * 1024));
      }
    } catch {
      // A driver that throws here is a driver we do not want to run on.
      hasWebGpu = false;
    }
  }

  cached = {
    hasWebGpu,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true,
    hasWebSpeechSynthesis: typeof speechSynthesis !== 'undefined',
    threads: Math.max(2, navigator.hardwareConcurrency ?? 4),
    ...(gpuDescription ? { gpuDescription } : {}),
    ...(maxBufferMb !== undefined ? { maxBufferMb } : {}),
  };
  return cached;
}

/** Test seam. */
export function __resetCapabilitiesCache(): void {
  cached = undefined;
}
