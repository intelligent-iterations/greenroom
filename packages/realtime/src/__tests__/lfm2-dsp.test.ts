import { describe, expect, it } from 'vitest';
import {
  computeMel,
  hannWindow,
  hzToMel,
  melFilterbank,
  melToHz,
  normalisePerFeature,
  rfft,
} from '../lfm2/mel.js';
import { STFT_BINS, STFT_FEATURE_WIDTH, irfft, istft } from '../lfm2/istft.js';
import {
  argmax,
  audioTokenIds,
  buildPrompt,
  isEndOfAudio,
  sampleTopK,
  sumCodebookEmbeddings,
} from '../lfm2/tokens.js';
import { CODEBOOK_VOCAB, MEL_CONFIG } from '../lfm2/config.js';

describe('mel scale', () => {
  it('is Slaney, not HTK', () => {
    // The two agree below 1kHz and diverge above it. 1000Hz is exactly the
    // Slaney breakpoint: 1000 / (200/3) = 15.
    expect(hzToMel(1000)).toBeCloseTo(15, 6);
    // HTK would give ~2595*log10(1+1000/700) = 999.99 here. If this ever
    // reads near 1000 the wrong formula has been substituted.
    expect(hzToMel(1000)).toBeLessThan(20);
  });

  it('round-trips', () => {
    for (const hz of [0, 100, 999, 1000, 4000, 8000]) {
      expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 4);
    }
  });

  it('is monotonic across the breakpoint', () => {
    let previous = -Infinity;
    for (let hz = 0; hz <= 8000; hz += 50) {
      const mel = hzToMel(hz);
      expect(mel).toBeGreaterThan(previous);
      previous = mel;
    }
  });
});

describe('mel filterbank', () => {
  const filters = melFilterbank(512, 128, 16_000, 0, 8000);

  it('produces one filter per mel bin, each the width of the rfft', () => {
    expect(filters).toHaveLength(128);
    expect(filters[0]).toHaveLength(512 / 2 + 1);
  });

  it('is area-normalised rather than peak-normalised', () => {
    // Slaney scaling makes low filters (narrow) peak higher than high ones
    // (wide). Equal peaks would mean the normalisation was skipped.
    const peak = (f: Float32Array) => Math.max(...f);
    expect(peak(filters[2] as Float32Array)).toBeGreaterThan(peak(filters[120] as Float32Array));
  });

  it('has no negative weights', () => {
    for (const f of filters) for (const v of f) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('hannWindow', () => {
  it('is periodic, not symmetric', () => {
    // A periodic Hann starts at 0 and never returns to 0 at the last sample;
    // the symmetric variant does. Using the wrong one breaks overlap-add.
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[7]).toBeGreaterThan(0);
  });
});

describe('rfft', () => {
  it('puts a pure tone in the expected bin', () => {
    const n = 64;
    const frame = new Float32Array(n);
    // Exactly 8 cycles across the window lands in bin 8.
    for (let i = 0; i < n; i++) frame[i] = Math.cos((2 * Math.PI * 8 * i) / n);
    const { re, im } = rfft(frame);
    const power = (k: number) => (re[k] as number) ** 2 + (im[k] as number) ** 2;
    expect(power(8)).toBeGreaterThan(power(7) * 100);
    expect(power(8)).toBeGreaterThan(power(9) * 100);
  });

  it('returns n/2+1 bins', () => {
    expect(rfft(new Float32Array(512)).re).toHaveLength(257);
  });
});

describe('computeMel', () => {
  it('frames with the configured hop and window', () => {
    // 16000 samples, win 400, hop 160 => 1 + (16000-400)/160 = 98 frames.
    const { frames, nMels } = computeMel(new Float32Array(16_000).fill(0.01));
    expect(frames).toBe(98);
    expect(nMels).toBe(128);
  });

  it('returns nothing for audio shorter than one window', () => {
    expect(computeMel(new Float32Array(100)).frames).toBe(0);
  });

  it('never produces NaN on digital silence', () => {
    // Silence has zero variance in every bin, so per-feature normalisation
    // divides by zero unless guarded — and NaN here reaches the model as
    // silence rather than as an error.
    const { data } = computeMel(new Float32Array(16_000));
    expect(data.length).toBeGreaterThan(0);
    for (const v of data) expect(Number.isNaN(v)).toBe(false);
  });

  it('standardises each bin over time', () => {
    const samples = new Float32Array(16_000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 7) * 0.3;
    const { data, frames, nMels } = computeMel(samples);

    for (const bin of [0, 40, 127]) {
      let sum = 0;
      for (let f = 0; f < frames; f++) sum += data[f * nMels + bin] as number;
      expect(sum / frames).toBeCloseTo(0, 3);
    }
  });

  it('uses the published configuration', () => {
    expect(MEL_CONFIG).toMatchObject({ nFft: 512, winLength: 400, hopLength: 160, nMels: 128 });
  });
});

describe('normalisePerFeature', () => {
  it('leaves a constant bin finite instead of NaN', () => {
    const data = new Float32Array([5, 5, 5, 5]);
    normalisePerFeature(data, 4, 1);
    for (const v of data) expect(v).toBe(0);
  });
});

describe('inverse STFT', () => {
  it('describes 641 complex bins as 1282 floats', () => {
    expect(STFT_BINS).toBe(641);
    expect(STFT_FEATURE_WIDTH).toBe(1282);
  });

  it('inverts rfft', () => {
    const n = 64;
    const signal = new Float32Array(n);
    for (let i = 0; i < n; i++) signal[i] = Math.sin(i / 3) * 0.5;
    const { re, im } = rfft(signal);
    const back = irfft(re, im, n);
    for (let i = 0; i < n; i++) expect(back[i]).toBeCloseTo(signal[i] as number, 4);
  });

  it('produces the right number of samples', () => {
    // (frames - 1) * hop + nFft
    const frames = 4;
    const features = new Float32Array(frames * STFT_FEATURE_WIDTH);
    expect(istft(features, frames)).toHaveLength((frames - 1) * 320 + 1280);
  });

  it('returns empty for no frames', () => {
    expect(istft(new Float32Array(0), 0)).toHaveLength(0);
  });

  it('does not produce NaN where frames do not overlap', () => {
    const features = new Float32Array(2 * STFT_FEATURE_WIDTH);
    features[0] = 1;
    for (const v of istft(features, 2)) expect(Number.isNaN(v)).toBe(false);
  });
});

describe('token bookkeeping', () => {
  it('offsets each codebook by its own stride', () => {
    // Getting this wrong still indexes a valid row, so the model receives a
    // real vector meaning something else. There is no loud failure.
    expect(audioTokenIds([5, 5, 5, 5, 5, 5, 5, 5])).toEqual([
      5,
      CODEBOOK_VOCAB + 5,
      2 * CODEBOOK_VOCAB + 5,
      3 * CODEBOOK_VOCAB + 5,
      4 * CODEBOOK_VOCAB + 5,
      5 * CODEBOOK_VOCAB + 5,
      6 * CODEBOOK_VOCAB + 5,
      7 * CODEBOOK_VOCAB + 5,
    ]);
  });

  it('detects end-of-audio in any codebook', () => {
    expect(isEndOfAudio([2048, 0, 0, 0, 0, 0, 0, 0])).toBe(true);
    expect(isEndOfAudio([0, 0, 0, 0, 0, 0, 0, 2048])).toBe(true);
    expect(isEndOfAudio([0, 1, 2, 3, 4, 5, 6, 7])).toBe(false);
  });

  it('builds the trained chat format exactly', () => {
    const prompt = buildPrompt({ system: 'S', user: 'U' });
    expect(prompt).toBe(
      '<|startoftext|><|im_start|>system\nS<|im_end|>\n<|im_start|>user\nU<|im_end|>\n<|im_start|>assistant\n',
    );
  });

  it('sums codebook embeddings', () => {
    const hidden = 3;
    const embeds = new Float32Array(8 * hidden).fill(1);
    expect([...sumCodebookEmbeddings(embeds, hidden)]).toEqual([8, 8, 8]);
  });
});

describe('sampling', () => {
  it('argmax finds the largest within a window', () => {
    const logits = new Float32Array([0, 9, 0, 5, 7]);
    expect(argmax(logits, 2, 3)).toBe(2); // index within the window
  });

  it('top-k with temperature 0 is greedy', () => {
    const logits = new Float32Array([1, 8, 3]);
    expect(sampleTopK(logits, 0, 3, 0, 2)).toBe(1);
  });

  it('top-k never returns anything outside the top k', () => {
    const logits = new Float32Array([10, 1, 9, 2]);
    for (let i = 0; i < 40; i++) {
      expect([0, 2]).toContain(sampleTopK(logits, 0, 4, 1, 2));
    }
  });

  it('does not overflow on large logits', () => {
    // Without subtracting the max, exp(900) is Infinity and every weight
    // becomes NaN, so sampling silently returns the last index forever.
    const logits = new Float32Array([900, 899, 1]);
    const picked = new Set<number>();
    for (let i = 0; i < 60; i++) picked.add(sampleTopK(logits, 0, 3, 1, 3));
    expect([...picked].every((i) => Number.isInteger(i))).toBe(true);
    expect(picked.has(0)).toBe(true);
  });
});
