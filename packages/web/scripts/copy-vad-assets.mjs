/**
 * Copies the voice-activity-detection runtime assets into public/vad/.
 *
 * @ricky0123/vad-web loads its AudioWorklet, its Silero weights and the ONNX
 * Runtime wasm binaries over HTTP from the application's own origin — they are
 * not bundled by Vite, because they are fetched at runtime by URL rather than
 * imported.
 *
 * When they are missing the failure is silent and severe: the SPA rewrite
 * answers the request with index.html and a 200, so the VAD tries to parse HTML
 * as an ONNX model, initialisation throws inside the library, and the app runs
 * with a dead microphone. It speaks and never hears you, with nothing obviously
 * wrong in the console. That is exactly the bug this fixes.
 *
 * `verify-assets.mjs` asserts the copy happened and that the files are served
 * with a sane content type, because a 200 alone proves nothing here.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Both packages restrict deep imports via `exports`, so resolve the public
 * entry point and take its directory rather than reaching for a file path that
 * the package map refuses to hand out.
 */
const vadDist = dirname(require.resolve('@ricky0123/vad-web'));
const ortDist = dirname(require.resolve('onnxruntime-web'));
const target = new URL('../public/vad/', import.meta.url).pathname;

await mkdir(target, { recursive: true });

const wanted = [
  [vadDist, 'silero_vad_v5.onnx'],
  [vadDist, 'silero_vad_legacy.onnx'],
  [vadDist, 'vad.worklet.bundle.min.js'],
];

// ORT picks a build at runtime from threading, SIMD and JSEP support, and each
// wasm binary has a sibling .mjs loader it imports dynamically. Copy every
// ort-wasm* variant rather than guessing: missing the loader for the variant the
// browser happens to choose fails with "no available backend found", which
// names none of the files involved.
for (const file of await readdir(ortDist)) {
  if (file.startsWith('ort-wasm') && (file.endsWith('.wasm') || file.endsWith('.mjs'))) {
    wanted.push([ortDist, file]);
  }
}

for (const [dir, file] of wanted) {
  await copyFile(join(dir, file), join(target, file));
}

console.log(`copied ${wanted.length} VAD runtime assets to public/vad/`);
for (const [, file] of wanted) console.log(`  ${file}`);
