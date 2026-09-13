/**
 * A fast Fourier transform, because the naive one made the model unusable.
 *
 * Both spectral paths here were direct O(n^2) DFTs with `Math.cos` and
 * `Math.sin` called inside the inner loop. For the ISTFT's 1280-point inverse
 * that is roughly 1.6 million trigonometric calls per frame, and a single
 * 320ms chunk of generated speech is two dozen frames. Synthesis ran several
 * times slower than realtime on the main thread, so a reply of any length
 * locked the tab solid — indistinguishable, from outside, from a hang.
 *
 * Two sizes matter and only one is convenient: the mel analysis is 512 points,
 * a power of two, and the ISTFT is 1280 = 2^8 x 5, which is not. Rather than
 * keep a fast path and a slow path, arbitrary lengths go through Bluestein's
 * algorithm, which expresses any DFT as a convolution and evaluates that with
 * power-of-two transforms.
 *
 * The naive implementations are kept in the tests as the reference these are
 * checked against. That is the only honest way to land an optimisation: the
 * fast version is correct because it agrees with the obvious version, not
 * because the arithmetic looks right.
 */

/** In-place radix-2 Cooley-Tukey. `re`/`im` must have a power-of-two length. */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fftRadix2 needs a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      // Recurrence rather than a trig call per butterfly. Over a 4096-point
      // transform the drift is far below float32, which is what the tensors are.
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const bRe = re[b] as number;
        const bIm = im[b] as number;
        const tRe = bRe * curRe - bIm * curIm;
        const tIm = bRe * curIm + bIm * curRe;
        const aRe = re[a] as number;
        const aIm = im[a] as number;
        re[b] = aRe - tRe;
        im[b] = aIm - tIm;
        re[a] = aRe + tRe;
        im[a] = aIm + tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] as number) / n;
      im[i] = (im[i] as number) / n;
    }
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Bluestein's algorithm: a DFT of any length as a convolution.
 *
 * Needed because 1280 is not a power of two. The chirp tables depend only on
 * the length, so they are built once and reused for every frame — which is the
 * difference between this being a win and being another slow path.
 */
interface Chirp {
  n: number;
  m: number;
  cosTable: Float64Array;
  sinTable: Float64Array;
  filterRe: Float64Array;
  filterIm: Float64Array;
}

const chirpCache = new Map<number, Chirp>();

function chirpFor(n: number): Chirp {
  const cached = chirpCache.get(n);
  if (cached) return cached;

  const m = nextPowerOfTwo(n * 2 - 1);
  const cosTable = new Float64Array(n);
  const sinTable = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // (i*i mod 2n) keeps the angle small enough to stay accurate for large n.
    const j = (i * i) % (n * 2);
    cosTable[i] = Math.cos((Math.PI * j) / n);
    sinTable[i] = Math.sin((Math.PI * j) / n);
  }

  const filterRe = new Float64Array(m);
  const filterIm = new Float64Array(m);
  filterRe[0] = cosTable[0] as number;
  filterIm[0] = sinTable[0] as number;
  for (let i = 1; i < n; i++) {
    filterRe[i] = filterRe[m - i] = cosTable[i] as number;
    filterIm[i] = filterIm[m - i] = sinTable[i] as number;
  }
  fftRadix2(filterRe, filterIm, false);

  const chirp: Chirp = { n, m, cosTable, sinTable, filterRe, filterIm };
  chirpCache.set(n, chirp);
  return chirp;
}

/** Forward DFT of arbitrary length, in place. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) === 0) {
    fftRadix2(re, im, false);
    return;
  }

  const { m, cosTable, sinTable, filterRe, filterIm } = chirpFor(n);
  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const c = cosTable[i] as number;
    const s = sinTable[i] as number;
    const x = re[i] as number;
    const y = im[i] as number;
    aRe[i] = x * c + y * s;
    aIm[i] = y * c - x * s;
  }

  fftRadix2(aRe, aIm, false);
  for (let i = 0; i < m; i++) {
    const x = aRe[i] as number;
    const y = aIm[i] as number;
    const fr = filterRe[i] as number;
    const fi = filterIm[i] as number;
    aRe[i] = x * fr - y * fi;
    aIm[i] = x * fi + y * fr;
  }
  fftRadix2(aRe, aIm, true);

  for (let i = 0; i < n; i++) {
    const c = cosTable[i] as number;
    const s = sinTable[i] as number;
    const x = aRe[i] as number;
    const y = aIm[i] as number;
    re[i] = x * c + y * s;
    im[i] = y * c - x * s;
  }
}

/**
 * Real-input forward transform, returning the non-redundant bins.
 *
 * The same signature the naive version had, so callers do not change.
 */
export function rfftFast(frame: Float32Array): { re: Float32Array; im: Float32Array } {
  const n = frame.length;
  const workRe = new Float64Array(n);
  const workIm = new Float64Array(n);
  for (let i = 0; i < n; i++) workRe[i] = frame[i] as number;

  fft(workRe, workIm);

  const bins = Math.floor(n / 2) + 1;
  const re = new Float32Array(bins);
  const im = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    re[k] = workRe[k] as number;
    im[k] = workIm[k] as number;
  }
  return { re, im };
}

/**
 * Inverse transform of a real signal's half-spectrum.
 *
 * Mirrors the bins into a full conjugate-symmetric spectrum and runs one
 * inverse transform, which is what makes this O(n log n) rather than the
 * per-sample summation it replaces.
 */
export function irfftFast(re: Float32Array, im: Float32Array, nFft: number): Float32Array {
  const workRe = new Float64Array(nFft);
  const workIm = new Float64Array(nFft);
  const bins = nFft / 2 + 1;

  for (let k = 0; k < bins; k++) {
    workRe[k] = re[k] as number;
    workIm[k] = im[k] as number;
  }
  // Hermitian symmetry: X[n-k] = conj(X[k]).
  for (let k = 1; k < nFft - bins + 1; k++) {
    workRe[nFft - k] = re[k] as number;
    workIm[nFft - k] = -(im[k] as number);
  }

  // The inverse is the conjugate of the forward transform of the conjugate.
  for (let i = 0; i < nFft; i++) workIm[i] = -(workIm[i] as number);
  fft(workRe, workIm);

  const out = new Float32Array(nFft);
  for (let i = 0; i < nFft; i++) out[i] = (workRe[i] as number) / nFft;
  return out;
}
