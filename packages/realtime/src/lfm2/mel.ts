import { MEL_CONFIG } from './config.js';

/**
 * The mel frontend the audio encoder expects.
 *
 * Parameters come from the model's own `onnx/mel_config.json`; none of them are
 * defaults. This is the least forgiving part of the whole pipeline: every step
 * here is a place where a plausible-looking alternative convention produces a
 * spectrogram that is subtly wrong, and the only symptom is that recognition is
 * poor. It never throws. So the conventions are pinned in comments and in
 * tests rather than left to whichever variant felt natural.
 *
 * In order: pre-emphasis, framing with a periodic Hann window, real FFT,
 * power spectrum, a Slaney-normalised mel filterbank, natural log with a guard,
 * and finally per-feature normalisation.
 */

/**
 * Slaney-style mel, which is what librosa calls `htk=False` and what
 * `mel_config.json` asks for with `"mel_norm": "slaney"`.
 *
 * Linear below 1kHz, logarithmic above. The HTK formula is the other common
 * convention and it is *close enough to look right* while shifting every filter
 * — which is exactly why this is written out rather than reached for from a
 * library.
 */
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = Math.log(6.4) / 27;

export function hzToMel(hz: number): number {
  if (hz < MIN_LOG_HZ) return hz / F_SP;
  return MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP;
}

export function melToHz(mel: number): number {
  if (mel < MIN_LOG_MEL) return mel * F_SP;
  return MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL));
}

/**
 * Triangular filterbank, area-normalised.
 *
 * Slaney normalisation scales each filter by 2/(right-left) so that filters
 * carry equal energy rather than equal peak height. Omitting it is the single
 * most common way a hand-written mel frontend ends up quietly mismatched with
 * the model that consumes it.
 */
export function melFilterbank(
  nFft: number,
  nMels: number,
  sampleRate: number,
  fMin: number,
  fMax: number,
): Float32Array[] {
  const bins = nFft / 2 + 1;
  const points = new Float64Array(nMels + 2);
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  for (let i = 0; i < points.length; i++) {
    points[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));
  }

  const binHz = sampleRate / nFft;
  const filters: Float32Array[] = [];
  for (let m = 0; m < nMels; m++) {
    const left = points[m] as number;
    const centre = points[m + 1] as number;
    const right = points[m + 2] as number;
    const filter = new Float32Array(bins);
    const scale = 2 / (right - left);
    for (let k = 0; k < bins; k++) {
      const hz = k * binHz;
      let weight = 0;
      if (hz >= left && hz <= centre && centre > left) weight = (hz - left) / (centre - left);
      else if (hz > centre && hz <= right && right > centre) weight = (right - hz) / (right - centre);
      filter[k] = weight * scale;
    }
    filters.push(filter);
  }
  return filters;
}

/** Periodic Hann, the STFT convention — not the symmetric one. */
export function hannWindow(length: number): Float32Array {
  const w = new Float32Array(length);
  for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  return w;
}

/**
 * Real FFT by direct evaluation.
 *
 * O(n²), and for n=512 over 100 frames a second that is fine — a few hundred
 * thousand operations against a 1.5B model's forward pass. Correctness first;
 * this is a well-defined hot spot to replace with a radix-2 FFT if a profile
 * ever says so, and having a slow reference to test against is worth more than
 * starting with the fast one.
 */
export function rfft(frame: Float32Array): { re: Float32Array; im: Float32Array } {
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

export interface MelResult {
  /** Flattened [frames, nMels], row-major — the encoder's input layout. */
  data: Float32Array;
  frames: number;
  nMels: number;
}

/**
 * PCM at 16kHz to the encoder's mel input.
 *
 * `normalize: "per_feature"` in the config means each mel bin is standardised
 * across time using that utterance's own mean and standard deviation — not a
 * global constant, and not per-frame. A single-frame input therefore has zero
 * variance everywhere, which is why the guard below matters.
 */
export function computeMel(samples: Float32Array, config = MEL_CONFIG): MelResult {
  const { nFft, winLength, hopLength, nMels, fMin, fMax, preemph, logZeroGuard } = config;

  // Pre-emphasis: y[n] = x[n] - 0.97 * x[n-1], with the first sample passed
  // through. Applied to the whole signal before framing, as the reference does.
  const emphasised = new Float32Array(samples.length);
  if (samples.length > 0) emphasised[0] = samples[0] as number;
  for (let i = 1; i < samples.length; i++) {
    emphasised[i] = (samples[i] as number) - preemph * (samples[i - 1] as number);
  }

  const frames = samples.length < winLength
    ? 0
    : 1 + Math.floor((samples.length - winLength) / hopLength);
  if (frames <= 0) return { data: new Float32Array(0), frames: 0, nMels };

  const window = hannWindow(winLength);
  const filters = melFilterbank(nFft, nMels, 16_000, fMin, fMax);
  const out = new Float32Array(frames * nMels);
  const buffer = new Float32Array(nFft);

  for (let f = 0; f < frames; f++) {
    const start = f * hopLength;
    buffer.fill(0);
    // Centre the 400-sample window inside the 512-point FFT, which is how a
    // win_length shorter than n_fft is conventionally handled.
    const pad = (nFft - winLength) >> 1;
    for (let i = 0; i < winLength; i++) {
      buffer[pad + i] = (emphasised[start + i] as number) * (window[i] as number);
    }

    const { re, im } = rfft(buffer);
    for (let m = 0; m < nMels; m++) {
      const filter = filters[m] as Float32Array;
      let energy = 0;
      for (let k = 0; k < filter.length; k++) {
        const weight = filter[k] as number;
        if (weight === 0) continue;
        const power = (re[k] as number) ** 2 + (im[k] as number) ** 2;
        energy += weight * power;
      }
      out[f * nMels + m] = Math.log(energy + logZeroGuard);
    }
  }

  normalisePerFeature(out, frames, nMels);
  return { data: out, frames, nMels };
}

/**
 * Standardise each mel bin over time, in place.
 *
 * The guard on standard deviation is not defensive noise: a constant bin — a
 * digital-silence recording, or a single frame — has zero variance, and
 * dividing by it yields NaN, which propagates through the whole model and
 * surfaces as silence rather than as an error.
 */
export function normalisePerFeature(data: Float32Array, frames: number, nMels: number): void {
  if (frames === 0) return;
  for (let m = 0; m < nMels; m++) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += data[f * nMels + m] as number;
    const mean = sum / frames;

    let variance = 0;
    for (let f = 0; f < frames; f++) variance += ((data[f * nMels + m] as number) - mean) ** 2;
    const std = Math.sqrt(variance / frames);
    const scale = std > 1e-5 ? 1 / std : 1;

    for (let f = 0; f < frames; f++) {
      data[f * nMels + m] = ((data[f * nMels + m] as number) - mean) * scale;
    }
  }
}
