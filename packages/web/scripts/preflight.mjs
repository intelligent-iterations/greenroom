/**
 * Static preflight: proves every on-device artifact resolves before running.
 *
 * Deterministic and cheap — HEAD requests only, no GPU, no downloads. Given a
 * repo, module and dtype, the ONNX URL is fully determined, so the whole
 * pipeline's file set can be verified in seconds instead of discovered ten
 * minutes into a failing session.
 *
 * Exits non-zero on the first missing artifact, and prints the URL, so a broken
 * model is a one-line diagnosis rather than an opaque `Cache.add()` error.
 */
import {
  MODEL_MANIFEST,
  expectedFiles,
  huggingFaceUrl,
} from '../src/voice/model-manifest.ts';

const devices = ['webgpu', 'wasm'];
let failures = 0;
let checked = 0;

for (const spec of MODEL_MANIFEST) {
  // The same file is often requested on both devices; check each URL once.
  const urls = new Map();
  for (const device of devices) {
    for (const file of expectedFiles(spec, device)) {
      urls.set(huggingFaceUrl(spec.repo, file), file);
    }
  }

  console.log(`\n${spec.stage.toUpperCase().padEnd(4)} ${spec.repo}`);
  for (const [url, file] of urls) {
    let status;
    try {
      status = (await fetch(url, { method: 'HEAD', redirect: 'follow' })).status;
    } catch (err) {
      status = `ERR ${err.message}`;
    }
    checked += 1;
    const ok = status === 200;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(status).padEnd(6)} ${file}`);
    if (!ok) console.log(`       ${url}`);
  }
}

console.log(
  `\n${checked - failures}/${checked} artifacts resolve across ${MODEL_MANIFEST.length} stages.`,
);
process.exit(failures === 0 ? 0 : 1);
