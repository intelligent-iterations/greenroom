/**
 * On-device pipeline benchmark.
 *
 * Measures the real cascade on real hardware: the same adapters the product
 * uses, the same prompt compiler, the same models. It exists because every
 * latency figure in the model catalogue was a seed value, and a router that
 * filters on invented numbers is a router making up its mind.
 *
 * Microphone input is replaced by pre-recorded 16kHz utterances so a run is
 * reproducible and can be driven headlessly. Everything downstream of the
 * microphone — resampling, recognition, generation, synthesis — is the
 * production path.
 *
 * Results are written to the DOM and to `window.__BENCH__` so an automation
 * driver can read them without scraping text.
 */
import {
  splitSpeakableChunks,
  type ChatMessage,
} from '@greenroom/shared';
import {
  compileInterviewerPrompt,
  type InterviewScenario,
  type LearnerState,
  findScenario,
} from '@greenroom/shared/interview';
import { detectCapabilities } from '../voice/capabilities.js';
import { MODEL_CATALOGUE } from '../voice/models.js';
import { InferencePipeline } from '../voice/pipeline-worker.js';

interface TurnMeasurement {
  turn: number;
  transcript: string;
  sttMs: number;
  firstTokenMs: number;
  firstAudioMs: number;
  turnaroundMs: number;
  outputTokensApprox: number;
  decodeTokPerSec: number;
  reply: string;
}

interface BenchResult {
  status: 'running' | 'done' | 'error';
  /** True if the tab was ever backgrounded during the run. */
  throttled?: boolean;
  device: Awaited<ReturnType<typeof detectCapabilities>> | null;
  modelId: string;
  loadMs?: number;
  warmUpMs?: number;
  turns: TurnMeasurement[];
  summary?: Record<string, number>;
  error?: string;
}

const result: BenchResult = { status: 'running', device: null, modelId: '', turns: [] };
(window as unknown as { __BENCH__: BenchResult }).__BENCH__ = result;

const root = document.getElementById('root')!;
const output = document.createElement('pre');
output.style.font = '13px ui-monospace, monospace';
output.style.padding = '16px';
output.style.whiteSpace = 'pre-wrap';
root.appendChild(output);

/**
 * Bounded log.
 *
 * The first version appended a DOM node per message and console-logged each
 * one. Model loaders emit a progress callback per chunk, which produced tens of
 * thousands of nodes, and the resulting layout work competed with the very
 * inference being measured. Instrumentation that perturbs the measurement is
 * worse than none, so this keeps a fixed-size tail and throttles the noisy
 * progress channel.
 */
const LOG_TAIL = 40;
const lines: string[] = [];
let lastProgressLog = 0;

function render(): void {
  output.textContent = `${JSON.stringify(result, null, 2)}\n\n${lines.join('\n')}`;
}

function log(message: string): void {
  lines.push(message);
  if (lines.length > LOG_TAIL) lines.shift();
  render();
}

/** Progress messages are high-frequency and low-value; sample them. */
function logProgress(message: string): void {
  const now = performance.now();
  if (now - lastProgressLog < 500) return;
  lastProgressLog = now;
  log(message);
}

/** Decodes a WAV to the mono 16kHz Float32 the recogniser contract requires. */
async function loadUtterance(url: string): Promise<Float32Array> {
  const bytes = await (await fetch(url)).arrayBuffer();
  // 16000 to match the file; no resampling, so this measures recognition rather
  // than an accidental resample.
  const ctx = new OfflineAudioContext(1, 1, 16_000);
  const decoded = await ctx.decodeAudioData(bytes);
  return decoded.getChannelData(0).slice();
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Chrome throttles hidden tabs hard — measured 6.4 MB/s hidden against 83 MB/s
 * for curl on the same machine, and GPU work is deprioritised too. A run in a
 * background tab produces numbers that look plausible and are wrong by an order
 * of magnitude, so the result is flagged rather than quietly reported.
 */
function watchVisibility(): void {
  const check = () => {
    if (document.visibilityState === 'hidden') {
      result.throttled = true;
      log('WARNING: tab backgrounded — results are throttled and not valid');
    }
  };
  check();
  document.addEventListener('visibilitychange', check);
}

async function main(): Promise<void> {
  try {
    watchVisibility();
    const caps = await detectCapabilities();
    result.device = caps;
    render();
    log(`WebGPU: ${caps.hasWebGpu} (${caps.gpuDescription ?? 'n/a'}), maxBuffer=${caps.maxBufferMb}MB`);
    if (!caps.hasWebGpu) throw new Error('No WebGPU: this benchmark measures the GPU path.');

    const scenario = findScenario('backend-mid-en') as InterviewScenario;
    const learner: LearnerState = {
      userId: 'bench',
      cefr: 'B2',
      seniority: 'mid',
      language: 'en',
      targetRole: 'Backend Engineer',
      mastery: [],
      recentErrors: [],
      sessionsCompleted: 0,
      updatedAt: 0,
      documents: [],
    };
    const prompt = compileInterviewerPrompt({ scenario, learner });

    const modelId =
      new URLSearchParams(location.search).get('model') ??
      MODEL_CATALOGUE.find((m) => m.vendor === 'on-device')!.id;
    result.modelId = modelId;
    log(`model: ${modelId}`);

    // Measures the pipeline as the product runs it: one worker, main thread free.
    const pipeline = new InferencePipeline('en');
    const { recognizer, model, synthesizer } = pipeline;

    const loadStart = performance.now();
    await pipeline.load((p) => logProgress(`${p.stage} ${(p.progress * 100).toFixed(0)}%`));
    result.loadMs = Math.round(performance.now() - loadStart);
    log(`loaded in ${result.loadMs}ms`);
    render();

    const warmStart = performance.now();
    await model.warmUp?.(prompt.system);
    result.warmUpMs = Math.round(performance.now() - warmStart);
    log(`warm-up ${result.warmUpMs}ms`);

    const utterances = ['/bench/answer-1.wav', '/bench/answer-2.wav'];
    const history: ChatMessage[] = [{ role: 'system', content: prompt.system }];

    for (const [index, url] of utterances.entries()) {
      const audio = await loadUtterance(url);

      // The anchor the product uses: the instant the learner stopped talking.
      const anchor = performance.now();

      const transcript = await recognizer.transcribe(audio, 16_000);
      const sttMs = performance.now() - anchor;
      history.push({ role: 'user', content: transcript.text });

      let firstTokenMs = 0;
      let firstAudioMs = 0;
      let reply = '';
      let buffer = '';
      let spoke = false;
      let tokens = 0;
      let decodeStart = 0;
      let speakQueue: Promise<void> = Promise.resolve();

      for await (const delta of model.generate(history, { maxTokens: 160 })) {
        if (!firstTokenMs) {
          firstTokenMs = performance.now() - anchor;
          decodeStart = performance.now();
        }
        tokens += 1;
        reply += delta;
        buffer += delta;

        const [chunks, rest] = splitSpeakableChunks(buffer, { allowClauseBreak: !spoke });
        buffer = rest;
        for (const chunk of chunks) {
          if (!spoke) {
            // First audible sample of the turn: the number learners feel.
            firstAudioMs = performance.now() - anchor;
            spoke = true;
          }
          // Chained, never awaited inside this loop. Awaiting here would block
          // decoding until the audio finished playing in real time, which is
          // what the orchestrator deliberately avoids — and what made an earlier
          // version of this benchmark report 2 tok/s for a model that does 90.
          speakQueue = speakQueue.then(() => synthesizer.speak(chunk)).catch(() => {});
        }
      }
      const tail = buffer.trim();
      if (tail) speakQueue = speakQueue.then(() => synthesizer.speak(tail)).catch(() => {});

      // Decode rate is measured over generation only. Turnaround is measured
      // after playback drains, because that is what the learner experiences.
      const decodeSec = (performance.now() - decodeStart) / 1000;
      await speakQueue;
      const turnaroundMs = performance.now() - anchor;

      history.push({ role: 'assistant', content: reply.trim() });
      const measurement: TurnMeasurement = {
        turn: index + 1,
        transcript: transcript.text,
        sttMs: Math.round(sttMs),
        firstTokenMs: Math.round(firstTokenMs),
        firstAudioMs: Math.round(firstAudioMs),
        turnaroundMs: Math.round(turnaroundMs),
        outputTokensApprox: tokens,
        decodeTokPerSec: Math.round(tokens / Math.max(decodeSec, 0.001)),
        reply: reply.trim(),
      };
      result.turns.push(measurement);
      log(`turn ${index + 1}: stt=${measurement.sttMs}ms ttft=${measurement.firstTokenMs}ms firstAudio=${measurement.firstAudioMs}ms`);
      render();
    }

    result.summary = {
      sttMsP50: Math.round(median(result.turns.map((t) => t.sttMs))),
      firstTokenMsP50: Math.round(median(result.turns.map((t) => t.firstTokenMs))),
      firstAudioMsP50: Math.round(median(result.turns.map((t) => t.firstAudioMs))),
      turnaroundMsP50: Math.round(median(result.turns.map((t) => t.turnaroundMs))),
      decodeTokPerSecP50: Math.round(median(result.turns.map((t) => t.decodeTokPerSec))),
    };
    result.status = 'done';
    if (result.throttled) {
      log('RESULTS INVALID: the tab was backgrounded at some point during this run.');
    }
    log(`DONE ${JSON.stringify(result.summary)}`);
    render();
  } catch (err) {
    result.status = 'error';
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log(`ERROR ${result.error}`);
    render();
  }
}

void main();
