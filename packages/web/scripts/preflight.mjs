/**
 * Static preflight: proves every on-device artifact resolves before running.
 *
 * Deterministic and cheap — no GPU, no full downloads. Given a repo, module and
 * dtype the ONNX URL is fully determined, so the whole pipeline's file set can
 * be verified in seconds instead of discovered ten minutes into a failing
 * session.
 *
 * It follows external data shards. Several models keep only the graph in
 * `model_q4f16.onnx` and the actual weights in `model_q4f16.onnx_data` and
 * `_data_1`. Checking the graph alone would pass a model whose weights are
 * missing, which is the exact failure mode this script exists to prevent —
 * checking the wrong thing is worse than not checking, because it buys
 * confidence.
 */
import {
  MODEL_MANIFEST,
  expectedFiles,
  huggingFaceUrl,
} from '../src/voice/model-manifest.ts';
import { MODEL_CATALOGUE } from '../src/voice/models.ts';

const devices = ['webgpu', 'wasm'];
let failures = 0;
let checked = 0;

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return { status: res.status, size: Number(res.headers.get('content-length') ?? 0) };
  } catch (err) {
    return { status: `ERR ${err.message}`, size: 0 };
  }
}

/** Files matching `<base>_data*`, discovered from the repository listing. */
async function externalShards(repo, base) {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${repo}`);
    if (!res.ok) return [];
    const body = await res.json();
    return (body.siblings ?? [])
      .map((s) => s.rfilename)
      .filter((f) => f.startsWith(`${base}_data`));
  } catch {
    return [];
  }
}

async function checkRepo(label, repo, files) {
  console.log(`\n${label}  ${repo}`);
  let bytes = 0;

  for (const file of files) {
    const { status, size } = await head(huggingFaceUrl(repo, file));
    checked += 1;
    const ok = status === 200;
    if (!ok) failures += 1;
    bytes += size;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(status).padEnd(6)} ${file}`);

    if (ok && file.endsWith('.onnx')) {
      for (const shard of await externalShards(repo, file)) {
        const r = await head(huggingFaceUrl(repo, shard));
        checked += 1;
        const shardOk = r.status === 200;
        if (!shardOk) failures += 1;
        bytes += r.size;
        console.log(`  ${shardOk ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(6)} ${shard}  (external weights)`);
      }
    }
  }

  if (bytes > 0) console.log(`       ~${Math.round(bytes / 1048576)} MB total`);
}

// Fixed pipeline stages (recognition, voice, VAD, and the default LLM).
for (const spec of MODEL_MANIFEST) {
  const files = new Set();
  for (const device of devices) for (const f of expectedFiles(spec, device)) files.add(f);
  await checkRepo(spec.stage.toUpperCase().padEnd(4), spec.repo, [...files]);
}

// Every selectable on-device model, since the learner can pick any of them.
const llmSpec = MODEL_MANIFEST.find((s) => s.stage === 'llm');
for (const model of MODEL_CATALOGUE.filter((m) => m.vendor === 'on-device')) {
  if (model.id === llmSpec?.repo) continue; // already checked above
  await checkRepo('LLM ', model.id, ['onnx/model_q4f16.onnx', ...llmSpec.extraFiles]);
}

console.log(`\n${checked - failures}/${checked} artifacts resolve.`);
process.exit(failures === 0 ? 0 : 1);
