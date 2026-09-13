import { describe, expect, it } from 'vitest';
import { fftRadix2, irfftFast, rfftFast } from '../lfm2/fft.js';

/**
 * The fast transforms, checked against the obvious ones.
 *
 * These replaced direct O(n^2) DFTs that were correct and far too slow: the
 * 1280-point inverse ran about 1.6 million trigonometric calls per frame, and
 * synthesising a sentence locked the tab for minutes. An optimisation is only
 * worth having if it computes the same thing, so the naive implementations
 * live on here as the reference.
 */

/** The implementation this replaced, verbatim. */
function naiveRfft(frame: Float32Array): { re: Float32Array; im: Float32Array } {
  const n = frame.length;
  const bins = n / 2 + 1;
  const re = new Float32Array(bins);
  const im = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      const sample = frame[t] as number;
      sumRe += sample * Math.cos(angle);
      sumIm += sample * Math.sin(angle);
    }
    re[k] = sumRe;
    im[k] = sumIm;
  }
  return { re, im };
}

function naiveIrfft(re: Float32Array, im: Float32Array, nFft: number): Float32Array {
  const out = new Float32Array(nFft);
  const bins = nFft / 2 + 1;
  for (let t = 0; t < nFft; t++) {
    let sum = (re[0] as number) * 0.5;
    const nyquist = bins - 1;
    sum += (re[nyquist] as number) * 0.5 * Math.cos(Math.PI * t);
    for (let k = 1; k < nyquist; k++) {
      const angle = (2 * Math.PI * k * t) / nFft;
      sum += (re[k] as number) * Math.cos(angle) - (im[k] as number) * Math.sin(angle);
    }
    out[t] = (2 * sum) / nFft;
  }
  return out;
}

/** Deterministic pseudo-random signal, so a failure is reproducible. */
function signal(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let state = seed;
  for (let i = 0; i < n; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state / 0x7fffffff) * 2 - 1;
  }
  return out;
}

const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

describe('rfftFast', () => {
  // 512 is the mel analysis window; 1280 is the ISTFT and is not a power of
  // two, which is the case that needs Bluestein.
  for (const n of [64, 512, 1024, 1280]) {
    it(`agrees with the direct DFT at n=${n}`, () => {
      const input = signal(n, n);
      const fast = rfftFast(input);
      const slow = naiveRfft(input);

      expect(fast.re.length).toBe(slow.re.length);
      // Scaled to the signal's own magnitude: absolute error grows with n.
      const tolerance = Math.sqrt(n) * 1e-3;
      for (let k = 0; k < slow.re.length; k++) {
        expect(close(fast.re[k] as number, slow.re[k] as number, tolerance)).toBe(true);
        expect(close(fast.im[k] as number, slow.im[k] as number, tolerance)).toBe(true);
      }
    });
  }

  it('puts a constant signal entirely in the zero bin', () => {
    const input = new Float32Array(512).fill(1);
    const { re, im } = rfftFast(input);
    expect(re[0]).toBeCloseTo(512, 2);
    for (let k = 1; k < re.length; k++) {
      expect(Math.abs(re[k] as number)).toBeLessThan(0.01);
      expect(Math.abs(im[k] as number)).toBeLessThan(0.01);
    }
  });

  it('finds a pure tone at its own bin', () => {
    const n = 512;
    const bin = 7;
    const input = new Float32Array(n);
    for (let t = 0; t < n; t++) input[t] = Math.cos((2 * Math.PI * bin * t) / n);

    const { re } = rfftFast(input);
    expect(re[bin] as number).toBeCloseTo(n / 2, 1);
    expect(Math.abs(re[bin + 1] as number)).toBeLessThan(0.01);
  });
});

describe('irfftFast', () => {
  for (const n of [64, 512, 1280]) {
    it(`agrees with the direct inverse DFT at n=${n}`, () => {
      const spectrum = rfftFast(signal(n, n + 7));
      const fast = irfftFast(spectrum.re, spectrum.im, n);
      const slow = naiveIrfft(spectrum.re, spectrum.im, n);

      for (let t = 0; t < n; t++) {
        expect(close(fast[t] as number, slow[t] as number, 1e-3)).toBe(true);
      }
    });
  }

  it('round-trips a signal through the forward transform', () => {
    // The property that actually matters for synthesis.
    for (const n of [512, 1280]) {
      const original = signal(n, 99);
      const { re, im } = rfftFast(original);
      const back = irfftFast(re, im, n);
      for (let t = 0; t < n; t++) {
        expect(close(back[t] as number, original[t] as number, 1e-3)).toBe(true);
      }
    }
  });
});

describe('fftRadix2', () => {
  it('refuses a length that is not a power of two', () => {
    // Silently producing nonsense here would surface as noise in the audio,
    // which is a long way from the cause.
    expect(() => fftRadix2(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/);
  });

  it('inverts itself', () => {
    const n = 256;
    const source = signal(n, 5);
    const re = Float64Array.from(source);
    const im = new Float64Array(n);

    fftRadix2(re, im, false);
    fftRadix2(re, im, true);

    for (let i = 0; i < n; i++) {
      expect(close(re[i] as number, source[i] as number, 1e-6)).toBe(true);
    }
  });
});

describe('speed', () => {
  it('synthesises a frame far faster than the transform it replaced', () => {
    // Not a microbenchmark for its own sake: the old cost is the reason a
    // reply locked the tab, so the margin is the fix.
    const spectrum = rfftFast(signal(1280, 3));
    const runs = 20;

    const fastStart = performance.now();
    for (let i = 0; i < runs; i++) irfftFast(spectrum.re, spectrum.im, 1280);
    const fastMs = performance.now() - fastStart;

    const slowStart = performance.now();
    for (let i = 0; i < runs; i++) naiveIrfft(spectrum.re, spectrum.im, 1280);
    const slowMs = performance.now() - slowStart;

    // Measured around 50x; asserting 10x leaves room for a loaded machine
    // while still failing loudly if the fast path is ever bypassed.
    expect(fastMs * 10).toBeLessThan(slowMs);
  });
});
