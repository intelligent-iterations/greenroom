import { irfftFast } from './fft.js';
import { ISTFT_CONFIG, OUTPUT_SAMPLE_RATE } from './config.js';

/**
 * Turning the detokenizer's output back into sound.
 *
 * `audio_detokenizer` emits `stft_features` shaped [batch, time, 1282], and
 * 1282 is 2 × 641 — real and imaginary parts of a 1280-point FFT's 641
 * non-redundant bins. So the last step of speech synthesis is an inverse STFT,
 * and it has to happen here because the graph stops short of the waveform.
 *
 * Overlap-add with window-squared normalisation, which is what makes
 * consecutive frames sum back to a continuous signal rather than a sequence of
 * 53ms tiles with audible seams every 13ms.
 */

/** Layout of the 1282-wide feature vector. */
export const STFT_BINS = ISTFT_CONFIG.nFft / 2 + 1; // 641
export const STFT_FEATURE_WIDTH = STFT_BINS * 2; // 1282

/** Periodic Hann, matching the analysis window. */
function hann(length: number): Float32Array {
  const w = new Float32Array(length);
  for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  return w;
}

/**
 * One inverse real FFT: 641 complex bins back to 1280 real samples.
 *
 * Direct evaluation, mirroring `rfft` in mel.ts. Bin 0 and the Nyquist bin have
 * no conjugate partner and so are not doubled; every other bin is. Doubling all
 * of them is a classic off-by-one that shows up as a faint tone rather than as
 * an obvious failure.
 */
export function irfft(re: Float32Array, im: Float32Array, nFft: number): Float32Array {
  // Delegated to fft.ts. As a direct summation this was ~1.6 million trig
  // calls per frame at nFft=1280, and a 320ms chunk of speech is two dozen
  // frames — synthesis ran slower than realtime on the main thread and locked
  // the tab. fft.ts is checked against the version this replaced.
  return irfftFast(re, im, nFft);
}

/**
 * The largest magnitude the head is allowed to ask for.
 *
 * The reference clips the exponentiated magnitude at 100. Without it a single
 * outlying bin — `exp` of a log-magnitude that drifted high — dominates the
 * whole frame.
 */
const MAX_MAGNITUDE = 100;

/**
 * [frames, 1282] to a waveform at 24kHz.
 *
 * `features` is the flattened detokenizer output for a single batch item, and
 * it is **not** a complex spectrum. The two halves are a log-magnitude and a
 * phase, the layout a Vocos-style ISTFT head emits: the spectrum is
 * `exp(a) * (cos(b) + i sin(b))`.
 *
 * This was read as [real, imaginary] instead, which is wrong in a way that
 * still produces plausibly-shaped output — the right number of samples, at the
 * right sample rate — so it would have survived any test that only counted
 * samples. Measured on the real detokenizer, the first half has mean -1.88 over
 * [-8.4, 4.7], which is a log-magnitude and nothing else; the second is
 * symmetric about zero and unbounded, which is a raw phase angle.
 */
export function istft(
  features: Float32Array,
  frames: number,
  config = ISTFT_CONFIG,
): Float32Array {
  const { nFft, hopLength } = config;
  if (frames <= 0) return new Float32Array(0);

  const window = hann(nFft);
  const length = (frames - 1) * hopLength + nFft;
  const out = new Float32Array(length);
  // Sum of squared windows, so overlapping frames can be divided back down.
  const norm = new Float32Array(length);

  const re = new Float32Array(STFT_BINS);
  const im = new Float32Array(STFT_BINS);

  for (let f = 0; f < frames; f++) {
    const base = f * STFT_FEATURE_WIDTH;
    for (let k = 0; k < STFT_BINS; k++) {
      const magnitude = Math.min(Math.exp(features[base + k] as number), MAX_MAGNITUDE);
      const phase = features[base + STFT_BINS + k] as number;
      re[k] = magnitude * Math.cos(phase);
      im[k] = magnitude * Math.sin(phase);
    }

    const frame = irfft(re, im, nFft);
    const start = f * hopLength;
    for (let i = 0; i < nFft; i++) {
      const w = window[i] as number;
      out[start + i] = (out[start + i] as number) + (frame[i] as number) * w;
      norm[start + i] = (norm[start + i] as number) + w * w;
    }
  }

  for (let i = 0; i < length; i++) {
    const n = norm[i] as number;
    if (n > 1e-8) out[i] = (out[i] as number) / n;
  }

  // Trim half a window from each end — `center=True`, the convention the
  // reference's STFT uses.
  //
  // Not cosmetic. At the very start and end only one window overlaps, and the
  // Hann taper takes the denominator above towards zero there, so those samples
  // are divided by almost nothing. Measured on a real frame: peak amplitude
  // 681 untrimmed against 0.24 trimmed, for audio that must live inside
  // [-1, 1]. Every chunk carried a burst of that at both ends.
  const edge = nFft / 2;
  return out.length > nFft ? out.slice(edge, out.length - edge) : new Float32Array(0);
}

/** Samples one audio frame becomes, for scheduling playback before the end. */
export function samplesPerFrame(): number {
  return ISTFT_CONFIG.hopLength;
}

export { OUTPUT_SAMPLE_RATE };
