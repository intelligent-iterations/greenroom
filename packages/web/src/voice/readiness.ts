import { MODEL_CATALOGUE } from './models.js';
import type { DeviceCapabilities } from './capabilities.js';

/**
 * What this machine can actually run, and what to tell someone it cannot.
 *
 * Separate from `selectModel`, which answers "which model" for a device that
 * can run one. This answers the question before that: whether there is any
 * on-device path at all, and if not, what the person in front of the screen
 * should do about it.
 *
 * It exists because the honest cost of an on-device default is that some
 * machines cannot pay it. Previously that surfaced as a model list with
 * everything greyed out and a cloud toggle that led to a 503 — a dead end
 * dressed as a choice. A dead end is fine; an unexplained one is not.
 *
 * Pure, so every branch is testable without a GPU.
 */
export type ReadinessVerdict =
  | { level: 'full'; device: 'webgpu'; headline: string; detail: string }
  | { level: 'degraded'; device: 'wasm'; headline: string; detail: string; expect: string }
  | { level: 'blocked'; headline: string; detail: string; remedies: string[] };

/** The smallest on-device LLM in the catalogue, which sets the floor. */
function smallestOnDeviceMb(): number {
  const sizes = MODEL_CATALOGUE.filter((m) => m.vendor === 'on-device').map((m) => m.vramMb ?? 0);
  return sizes.length > 0 ? Math.min(...sizes) : 0;
}

export function assessReadiness(caps: DeviceCapabilities): ReadinessVerdict {
  const floor = smallestOnDeviceMb();

  if (caps.hasWebGpu) {
    // maxBufferSize is the honest proxy for what will fit: weights are
    // allocated as buffers, so a model above this limit cannot load however
    // much memory the machine has. See capabilities.ts.
    if (caps.maxBufferMb !== undefined && caps.maxBufferMb < floor) {
      return {
        level: 'blocked',
        headline: 'This GPU is too small for any bundled model',
        detail:
          `WebGPU is available${caps.gpuDescription ? ` on ${caps.gpuDescription}` : ''}, but it ` +
          `allows at most ${caps.maxBufferMb} MB in a single buffer, and the smallest bundled ` +
          `model needs about ${floor} MB.`,
        remedies: [
          'Close other tabs — a browser shares its GPU budget across all of them.',
          'Point the app at a smaller model on Hugging Face, or a folder of models on disk.',
          'Try a machine with a discrete GPU.',
        ],
      };
    }
    return {
      level: 'full',
      device: 'webgpu',
      headline: 'This machine can run everything on device',
      detail:
        `WebGPU is available${caps.gpuDescription ? ` on ${caps.gpuDescription}` : ''}. ` +
        'Speech recognition, the model and the voice all run in this tab; no audio and no ' +
        'transcript leaves the machine.',
    };
  }

  // No WebGPU. Threaded WASM is the only remaining engine, and it needs
  // SharedArrayBuffer, which needs the COOP/COEP headers to have arrived.
  if (caps.hasSharedArrayBuffer) {
    return {
      level: 'degraded',
      device: 'wasm',
      headline: 'No WebGPU — this will run on the CPU, slowly',
      detail:
        `This browser exposes no WebGPU adapter, so the pipeline falls back to multi-threaded ` +
        `WASM across ${caps.threads} threads. Speech recognition and the voice cope with that. ` +
        'The language model is the problem: it is the one stage where a GPU is the difference ' +
        'between a conversation and a wait.',
      expect:
        'Expect several seconds of silence per reply rather than the ~1.2s a GPU gives. That is ' +
        'an estimate, not a measurement — no CPU-only run is recorded. Usable for scoring a ' +
        'model against a set of cases; not usable as a spoken conversation.',
    };
  }

  return {
    level: 'blocked',
    headline: 'This browser cannot run the pipeline',
    detail:
      'There is no WebGPU adapter and no SharedArrayBuffer, so neither inference engine is ' +
      'available. Nothing here will work until one of them is.',
    remedies: [
      'Use a Chromium-based browser (Chrome or Edge 113+) or Safari 18+.',
      'On Linux, WebGPU may need enabling at chrome://flags/#enable-unsafe-webgpu.',
      'SharedArrayBuffer needs cross-origin isolation — if you are self-hosting, check the ' +
        'Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.',
      'A private window or a strict content blocker can suppress both.',
    ],
  };
}
