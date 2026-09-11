import type { LoadProgress, LoadStage } from '@greenroom/shared';

/**
 * Aggregated download state.
 *
 * The old progress bar went backwards twice and then jittered, and neither was
 * a rendering bug — it was showing whatever had reported last. Three stages
 * each ran 0..1, and *within* a stage transformers.js reports per file, so
 * Whisper alone resets it three times for its encoder, decoder and tokenizer.
 *
 * So progress is accumulated in bytes across every file of every stage, and the
 * fraction is clamped monotonic. Totals are discovered as files start, which
 * means an honest fraction genuinely can decrease; a bar that goes backwards
 * reads as a failure, so it holds instead and the number catches up.
 */
export interface StageDownload {
  stage: LoadStage;
  label: string;
  /** Best estimate before anything starts, so the list has a shape immediately. */
  expectedBytes: number;
  loadedBytes: number;
  /** Sum of the totals reported so far, which is only known once files begin. */
  reportedBytes: number;
  cached: boolean;
  done: boolean;
}

export interface DownloadState {
  stages: StageDownload[];
  loadedBytes: number;
  totalBytes: number;
  /** 0..1, monotonic by construction. */
  fraction: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
  /** The artifact currently in flight, for the detail line. */
  currentFile?: string;
  startedAt?: number;
  done: boolean;
  /** Per-file byte counts, keyed `stage:file`. Not for rendering. */
  files: Record<string, { loaded: number; total: number }>;
}

const LABELS: Record<LoadStage, string> = {
  stt: 'Speech recognition',
  llm: 'Language model',
  tts: 'Voice',
};

export function initialDownloadState(expected: Record<LoadStage, number>): DownloadState {
  return {
    stages: (['stt', 'llm', 'tts'] as LoadStage[]).map((stage) => ({
      stage,
      label: LABELS[stage],
      expectedBytes: expected[stage],
      loadedBytes: 0,
      reportedBytes: 0,
      cached: false,
      done: false,
    })),
    loadedBytes: 0,
    totalBytes: Object.values(expected).reduce((a, b) => a + b, 0),
    fraction: 0,
    done: false,
    files: {},
  };
}

/** Smoothing for the rate. Raw deltas swing wildly between chunks. */
const RATE_SMOOTHING = 0.3;
/** Ignore rate samples closer together than this; they measure nothing. */
const MIN_RATE_INTERVAL_MS = 250;

export function reduceProgress(
  prev: DownloadState,
  event: LoadProgress,
  now: number,
): DownloadState {
  const files = { ...prev.files };
  const key = `${event.stage}:${event.file ?? '_'}`;

  if (event.loaded !== undefined && event.total !== undefined) {
    files[key] = { loaded: event.loaded, total: event.total };
  } else if (event.progress >= 1) {
    // A stage or file finishing without byte counts — usually a cache hit.
    const known = files[key];
    if (known) files[key] = { loaded: known.total, total: known.total };
  }

  const loadedBytes = Object.values(files).reduce((sum, f) => sum + f.loaded, 0);
  const reportedTotal = Object.values(files).reduce((sum, f) => sum + f.total, 0);

  const stages = prev.stages.map((s) => {
    if (s.stage !== event.stage) return s;
    const mine = Object.entries(files).filter(([k]) => k.startsWith(`${s.stage}:`));
    return {
      ...s,
      loadedBytes: mine.reduce((sum, [, f]) => sum + f.loaded, 0),
      reportedBytes: mine.reduce((sum, [, f]) => sum + f.total, 0),
      cached: s.cached || Boolean(event.cached),
      done: s.done || event.progress >= 1,
    };
  });

  // Prefer measured bytes once they exceed the estimate, so a wrong estimate
  // corrects upward rather than pinning the bar at 100% with files still to go.
  const estimateForUnstarted = stages
    .filter((s) => s.reportedBytes === 0 && !s.done)
    .reduce((sum, s) => sum + s.expectedBytes, 0);
  const totalBytes = Math.max(reportedTotal + estimateForUnstarted, prev.totalBytes ? 0 : 1);

  const rawFraction = totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0;
  const allDone = stages.every((s) => s.done);

  // Monotonic. A total discovered late can legitimately lower the true
  // fraction; holding is honest, going backwards looks like a failure.
  const fraction = allDone ? 1 : Math.max(prev.fraction, rawFraction);

  const startedAt = prev.startedAt ?? now;
  const elapsed = now - startedAt;
  let bytesPerSecond = prev.bytesPerSecond;
  if (elapsed > MIN_RATE_INTERVAL_MS && loadedBytes > prev.loadedBytes) {
    const sample = ((loadedBytes - prev.loadedBytes) / (now - (prev.startedAt ?? now))) * 1000;
    const instant = Number.isFinite(sample) && sample > 0 ? (loadedBytes / elapsed) * 1000 : undefined;
    if (instant !== undefined) {
      bytesPerSecond =
        prev.bytesPerSecond === undefined
          ? instant
          : prev.bytesPerSecond * (1 - RATE_SMOOTHING) + instant * RATE_SMOOTHING;
    }
  }

  const remaining = Math.max(0, totalBytes - loadedBytes);
  const etaSeconds =
    bytesPerSecond && bytesPerSecond > 0 && !allDone ? remaining / bytesPerSecond : undefined;

  return {
    stages,
    files,
    loadedBytes,
    totalBytes,
    fraction,
    done: allDone,
    startedAt,
    ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
    ...(etaSeconds !== undefined ? { etaSeconds } : {}),
    ...(event.file ? { currentFile: event.file } : {}),
  };
}

/** "1.06 GB", "276 MB". Sized to the value so the eye is not counting digits. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** Deliberately coarse: a precise countdown that is wrong is worse than a range. */
export function formatEta(seconds: number): string {
  if (seconds < 20) return 'a few seconds';
  if (seconds < 90) return 'about a minute';
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minutes`;
}
