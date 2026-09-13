/**
 * A static server for the built app, and nothing else.
 *
 * `vite preview` loads the whole Vite toolchain to serve files that are already
 * built — on a memory-constrained machine that was enough to get the process
 * OOM-killed three times in one session, each time in the middle of testing.
 * This is Node's http module and a MIME table.
 *
 * The headers are the entire reason this cannot be `python -m http.server`.
 * Cross-origin isolation is what gives the page SharedArrayBuffer, and so
 * multi-threaded WASM; without it onnxruntime-web silently falls back to a
 * single thread and everything is several times slower with no error. COEP is
 * `credentialless` rather than `require-corp` because model weights come from
 * the Hugging Face CDN, which sends no CORP header — `require-corp` blocks them
 * outright. Keep these matching vite.config.ts and firebase.json.
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const PORT = Number(process.argv[2] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  // normalize collapses `..`, and the prefix check rejects anything that still
  // escapes the root — this serves a directory, not the filesystem.
  const requested = join(ROOT, normalize(decodeURIComponent(url.pathname)));
  const path = requested.startsWith(ROOT) ? requested : ROOT;

  let file = path;
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
  } catch {
    // Single-page app: unknown paths are routes, not missing files.
    file = join(ROOT, 'index.html');
  }

  try {
    statSync(file);
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(response);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving dist on http://127.0.0.1:${PORT}`);
});
