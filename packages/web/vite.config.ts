import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Cross-origin isolation.
 *
 * onnxruntime-web only uses multi-threaded WASM when SharedArrayBuffer is
 * available, which requires COOP+COEP. On CPU-only machines — the fallback path
 * this product has to support — single-threaded Whisper is roughly 3x slower,
 * so these headers are the difference between usable and not.
 *
 * COEP is `credentialless` rather than `require-corp` deliberately: model
 * weights are fetched cross-origin from the Hugging Face CDN, which does not
 * send CORP headers, and `require-corp` blocks them outright.
 *
 * These headers must be reproduced by whatever serves the production build.
 * firebase.json sets the same pair; see docs/ARCHITECTURE.md.
 */
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  // These ship prebuilt WASM/worker assets that Vite's dep optimiser mangles.
  optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers', 'kokoro-js'] },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      // The app is the only entry that ships. The rest are instruments —
      // benchmarks, the eval runner, hardware probes — that drive the
      // production adapters on real hardware. They are useful, they are not
      // product, and publishing them would put an unauthenticated page that
      // downloads gigabytes of models on a public origin.
      //
      // Build them for local work with `pnpm build:dev`.
      input: process.env.INCLUDE_DEV_PAGES
        ? {
            main: 'index.html',
            bench: 'bench.html',
            diag: 'diag.html',
            vadcheck: 'vadcheck.html',
            probe: 'probe.html',
            evals: 'evals.html',
          }
        : { main: 'index.html' },
    },
  },
});
