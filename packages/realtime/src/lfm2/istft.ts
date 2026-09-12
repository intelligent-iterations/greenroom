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

/**
 * [frames, 1282] to a waveform at 24kHz.
 *
 * `features` is the flattened detokenizer output for a single batch item.
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
      re[k] = features[base + k] as number;
      im[k] = features[base + STFT_BINS + k] as number;
    }

    const frame = irfft(re, im, nFft);
    const start = f * hopLength;
    for (let i = 0; i < nFft; i++) {
      const w = window[i] as number;
      out[start + i] = (out[start + i] as number) + (frame[i] as number) * w;
      norm[start + i] = (norm[start + i] as number) + w * w;
    }
  }

  // Where no window overlapped, the normaliser is ~0; leaving those samples
  // alone is correct, dividing by the epsilon would amplify numerical dust into
  // clicks at the edges of every utterance.
  for (let i = 0; i < length; i++) {
    const n = norm[i] as number;
    if (n > 1e-8) out[i] = (out[i] as number) / n;
  }

  return out;
}

/** Samples one audio frame becomes, for scheduling playback before the end. */
export function samplesPerFrame(): number {
  return ISTFT_CONFIG.hopLength;
}

export { OUTPUT_SAMPLE_RATE };
