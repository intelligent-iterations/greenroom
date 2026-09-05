/**
 * Asserts the VAD runtime assets are present and served as themselves.
 *
 * Status alone proves nothing here: the SPA rewrite returns index.html with a
 * 200 for any missing path, which is precisely how a dead microphone shipped
 * unnoticed. So this checks the content type too, and against a running server
 * when one is given.
 *
 *   node scripts/verify-assets.mjs            # checks dist/ on disk
 *   node scripts/verify-assets.mjs http://localhost:5179
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const REQUIRED = [
  ['vad/silero_vad_v5.onnx', 'onnx'],
  ['vad/vad.worklet.bundle.min.js', 'javascript'],
  ['vad/ort-wasm-simd-threaded.jsep.wasm', 'wasm'],
];

const origin = process.argv[2];
let failed = 0;

if (origin) {
  for (const [path, kind] of REQUIRED) {
    const url = `${origin.replace(/\/$/, '')}/${path}`;
    let status = 0;
    let type = '';
    try {
      const res = await fetch(url);
      status = res.status;
      type = res.headers.get('content-type') ?? '';
    } catch (err) {
      type = `ERR ${err.message}`;
    }
    // An HTML content type means the SPA fallback answered — the asset is
    // missing even though the status says 200.
    const ok = status === 200 && !type.includes('text/html');
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${status} ${type.padEnd(26)} ${path}`);
    if (!ok && type.includes('text/html')) {
      console.log('       served index.html — asset missing, masked by the SPA rewrite');
    }
    void kind;
  }
} else {
  const dist = new URL('../dist/', import.meta.url).pathname;
  for (const [path] of REQUIRED) {
    try {
      const info = await stat(join(dist, path));
      const ok = info.size > 1024;
      if (!ok) failed += 1;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(info.size).padStart(9)} bytes  ${path}`);
    } catch {
      failed += 1;
      console.log(`FAIL      missing  ${path}`);
    }
  }
}

console.log(`\n${REQUIRED.length - failed}/${REQUIRED.length} VAD assets present.`);
process.exit(failed === 0 ? 0 : 1);
