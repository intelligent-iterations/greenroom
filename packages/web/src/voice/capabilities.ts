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
}

let cached: DeviceCapabilities | undefined;

export async function detectCapabilities(): Promise<DeviceCapabilities> {
  if (cached) return cached;

  let hasWebGpu = false;
  let gpuDescription: string | undefined;

  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        hasWebGpu = true;
        // `info` is not in every browser's typings yet but is widely shipped.
        const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
        gpuDescription = info ? [info.vendor, info.architecture].filter(Boolean).join(' ') : 'WebGPU';
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
  };
  return cached;
}

/** Test seam. */
export function __resetCapabilitiesCache(): void {
  cached = undefined;
}
