/**
 * Proves the voice-activity detector initialises with the assets we ship.
 *
 * Uses a synthetic MediaStream rather than the microphone, so it needs no
 * permission prompt and can run headlessly. That is enough to exercise the part
 * that was broken — fetching the worklet, the Silero weights and the ONNX
 * runtime wasm from our own origin — which previously failed silently because
 * the SPA rewrite answered every missing asset with index.html.
 *
 * It does not prove endpointing quality or barge-in behaviour against real
 * speech. Those need a human and a microphone.
 */
import { MicVAD } from '@ricky0123/vad-web';
import { VAD_ASSET_PATH } from '../voice/vad.js';

const out = document.getElementById('out')!;
const result: Record<string, unknown> = { stage: 'starting', assetPath: VAD_ASSET_PATH };
const show = () => (out.textContent = JSON.stringify(result, null, 2));
show();

/** A silent stream, so nothing depends on a microphone or on permissions. */
function syntheticStream(): MediaStream {
  const ctx = new AudioContext({ sampleRate: 16_000 });
  const destination = ctx.createMediaStreamDestination();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0; // silent: we are testing initialisation, not detection
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  return destination.stream;
}

async function main() {
  // Check each asset resolves as itself. A 200 is not enough — the SPA rewrite
  // returns index.html with a 200 for anything missing.
  result.assets = {};
  for (const file of ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']) {
    const res = await fetch(`${VAD_ASSET_PATH}${file}`);
    const type = res.headers.get('content-type') ?? '';
    (result.assets as Record<string, string>)[file] =
      res.ok && !type.includes('text/html') ? `ok (${type || 'no type'})` : `BAD (${res.status} ${type})`;
  }
  show();

  result.stage = 'constructing MicVAD';
  show();

  const stream = syntheticStream();
  let speechStarts = 0;

  const vad = await MicVAD.new({
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    model: 'v5',
    baseAssetPath: VAD_ASSET_PATH,
    onnxWASMBasePath: VAD_ASSET_PATH,
    onSpeechStart: () => {
      speechStarts += 1;
    },
    onSpeechEnd: () => {},
    onVADMisfire: () => {},
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.4,
    redemptionMs: 800,
    minSpeechMs: 150,
    preSpeechPadMs: 250,
    submitUserSpeechOnPause: false,
    startOnLoad: false,
  });

  await vad.start();
  result.stage = 'running';
  result.listening = vad.listening;
  show();

  // Let a few frames flow so the worklet and the ONNX session are exercised,
  // not merely constructed.
  await new Promise((r) => setTimeout(r, 2500));

  result.framesProcessedWithoutError = true;
  result.errored = vad.errored ?? null;
  result.speechStartsOnSilence = speechStarts; // expected 0
  await vad.destroy();
  result.stage = 'done';
  show();
}

main().catch((e) => {
  result.stage = 'error';
  result.error = `${e.name}: ${e.message}`;
  show();
});
