import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatEta,
  initialDownloadState,
  reduceProgress,
  type DownloadState,
} from '../download.js';

const EXPECTED = { stt: 276e6, llm: 1057e6, tts: 310e6 };
type Event = Parameters<typeof reduceProgress>[1];

function run(events: Array<[Event, number]>): DownloadState {
  return events.reduce((s, [e, t]) => reduceProgress(s, e, t), initialDownloadState(EXPECTED));
}

describe('download progress', () => {
  /**
   * The reported bug, and the reason this module exists. Three stages each ran
   * 0..1, and every file within a stage reset it again, so one load sent the
   * bar backwards several times.
   */
  it('never goes backwards across files or stages', () => {
    const events: Array<[Event, number]> = [
      [{ stage: 'stt', progress: 0.9, file: 'encoder.onnx', loaded: 90e6, total: 100e6 }, 1000],
      [{ stage: 'stt', progress: 1, file: 'encoder.onnx', loaded: 100e6, total: 100e6 }, 2000],
      // A new file starts at zero — the old bar snapped back here.
      [{ stage: 'stt', progress: 0.1, file: 'decoder.onnx', loaded: 10e6, total: 176e6 }, 3000],
      // A new stage starts at zero — and here.
      [{ stage: 'llm', progress: 0.02, file: 'model.onnx', loaded: 20e6, total: 1057e6 }, 4000],
    ];

    let state = initialDownloadState(EXPECTED);
    const seen: number[] = [];
    for (const [event, t] of events) {
      state = reduceProgress(state, event, t);
      seen.push(state.fraction);
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i], `sample ${i} dropped below ${seen[i - 1]}`).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
  });

  it('accumulates bytes across every file rather than showing the last one', () => {
    const state = run([
      [{ stage: 'stt', progress: 1, file: 'a', loaded: 100e6, total: 100e6 }, 1000],
      [{ stage: 'llm', progress: 0.5, file: 'b', loaded: 500e6, total: 1000e6 }, 2000],
    ]);
    expect(state.loadedBytes).toBe(600e6);
  });

  it('holds rather than dropping when a late total makes the honest fraction smaller', () => {
    let state = reduceProgress(
      initialDownloadState({ stt: 10e6, llm: 10e6, tts: 10e6 }),
      { stage: 'stt', progress: 1, file: 'a', loaded: 10e6, total: 10e6 },
      1000,
    );
    const before = state.fraction;
    state = reduceProgress(
      state,
      { stage: 'llm', progress: 0.01, file: 'b', loaded: 1e6, total: 900e6 },
      2000,
    );
    expect(state.fraction).toBeGreaterThanOrEqual(before);
  });

  it('reaches exactly 1 when every stage is done', () => {
    const state = run([
      [{ stage: 'stt', progress: 1, file: 'a', loaded: 1e6, total: 1e6 }, 1000],
      [{ stage: 'llm', progress: 1, file: 'b', loaded: 1e6, total: 1e6 }, 2000],
      [{ stage: 'tts', progress: 1, file: 'c', loaded: 1e6, total: 1e6 }, 3000],
    ]);
    expect(state.done).toBe(true);
    expect(state.fraction).toBe(1);
  });

  // A cached stage completes instantly. Showing it race 0 to 100% suggests a
  // download that did not happen.
  it('marks a stage cached when it finished without transferring bytes', () => {
    const state = run([[{ stage: 'stt', progress: 1, cached: true }, 1000]]);
    expect(state.stages.find((s) => s.stage === 'stt')).toMatchObject({ cached: true, done: true });
  });

  it('keeps every stage in the list from the first render', () => {
    const state = initialDownloadState(EXPECTED);
    expect(state.stages.map((s) => s.stage)).toEqual(['stt', 'llm', 'tts']);
    expect(state.stages.every((s) => s.expectedBytes > 0)).toBe(true);
  });

  it('does not label a stage with an implementation name', () => {
    const labels = initialDownloadState(EXPECTED).stages.map((s) => s.label);
    expect(labels).toEqual(['Speech recognition', 'Language model', 'Voice']);
    expect(labels.join(' ')).not.toMatch(/interviewer|whisper|kokoro|onnx/i);
  });

  it('offers a rate and an estimate once there is something to measure', () => {
    const state = run([
      [{ stage: 'llm', progress: 0.1, file: 'a', loaded: 100e6, total: 1000e6 }, 1000],
      [{ stage: 'llm', progress: 0.2, file: 'a', loaded: 200e6, total: 1000e6 }, 11_000],
    ]);
    expect(state.bytesPerSecond).toBeGreaterThan(0);
    expect(state.etaSeconds).toBeGreaterThan(0);
  });
});

describe('formatting', () => {
  it('sizes the unit to the value', () => {
    expect(formatBytes(1_057_000_000)).toBe('1.06 GB');
    expect(formatBytes(276_000_000)).toBe('276 MB');
  });

  // A precise countdown that is wrong is worse than an honest range.
  it('stays coarse about time', () => {
    expect(formatEta(8)).toBe('a few seconds');
    expect(formatEta(45)).toBe('about a minute');
    expect(formatEta(240)).toBe('about 4 minutes');
  });
});
