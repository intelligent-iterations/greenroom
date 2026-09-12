import { AUDIO_START_TOKEN, CODEBOOK_VOCAB, END_OF_AUDIO, NUM_CODEBOOKS } from './config.js';

/**
 * Token bookkeeping for the interleaved text/audio stream.
 *
 * Small, and worth isolating: the codebook stride in particular is an
 * arithmetic detail with no safe failure mode. Offsetting by the wrong stride
 * still indexes a valid embedding row, so the model receives a real vector that
 * means something else entirely, and the output is confident nonsense rather
 * than an error.
 */

/**
 * Flatten per-codebook codes into rows of the shared audio embedding table.
 *
 * Codebook `c` owns rows `[c * 2049, (c+1) * 2049)`. From the reference loop:
 * `frameCodes.map((code, cb) => cb * codebookVocab + code)`.
 */
export function audioTokenIds(frameCodes: readonly number[]): number[] {
  return frameCodes.map((code, codebook) => codebook * CODEBOOK_VOCAB + code);
}

/** End-of-audio is 2048 in any codebook; the first is what the loop watches. */
export function isEndOfAudio(frameCodes: readonly number[]): boolean {
  return frameCodes.some((code) => code === END_OF_AUDIO);
}

export function isAudioStart(token: number): boolean {
  return token === AUDIO_START_TOKEN;
}

/**
 * The chat format the model was trained on, from the model card.
 *
 * Written out rather than assembled from a template helper so the exact
 * newlines are visible: they are part of the format, and a missing one shifts
 * every token after it.
 */
export function buildPrompt(options: {
  system: string;
  user?: string;
}): string {
  const user = options.user ?? '';
  return (
    '<|startoftext|><|im_start|>system\n' +
    options.system +
    '<|im_end|>\n<|im_start|>user\n' +
    user +
    '<|im_end|>\n<|im_start|>assistant\n'
  );
}

/**
 * Sum the per-codebook embeddings into the single vector the decoder consumes.
 *
 * The residual quantiser's whole premise is that codebooks are additive
 * refinements of one another, so the frame's representation is their sum.
 * `embeds` is [1, NUM_CODEBOOKS, hidden] flattened.
 */
export function sumCodebookEmbeddings(embeds: Float32Array, hidden: number): Float32Array {
  const out = new Float32Array(hidden);
  for (let c = 0; c < NUM_CODEBOOKS; c++) {
    const base = c * hidden;
    for (let i = 0; i < hidden; i++) out[i] = (out[i] as number) + (embeds[base + i] as number);
  }
  return out;
}

/** Greedy pick over a logits row. */
export function argmax(logits: Float32Array, offset = 0, length = logits.length - offset): number {
  let best = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < length; i++) {
    const v = logits[offset + i] as number;
    if (v > bestValue) {
      bestValue = v;
      best = i;
    }
  }
  return best;
}

/**
 * Temperature plus top-k sampling, for the audio codebooks.
 *
 * Audio wants sampling rather than argmax — the card exposes
 * `--audio-temperature` and `--audio-top-k` precisely because greedy audio
 * collapses into flat, buzzing output. Text stays greedy by default.
 */
export function sampleTopK(
  logits: Float32Array,
  offset: number,
  length: number,
  temperature: number,
  topK: number,
  random: () => number = Math.random,
): number {
  if (temperature <= 0) return argmax(logits, offset, length);

  const indices = Array.from({ length }, (_, i) => i);
  indices.sort((a, b) => (logits[offset + b] as number) - (logits[offset + a] as number));
  const kept = indices.slice(0, Math.max(1, Math.min(topK, length)));

  const top = logits[offset + (kept[0] as number)] as number;
  // Subtract the max before exponentiating; without it a logit of 90 overflows
  // to Infinity and the distribution becomes NaN.
  const weights = kept.map((i) => Math.exp(((logits[offset + i] as number) - top) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);

  let r = random() * total;
  for (let i = 0; i < kept.length; i++) {
    r -= weights[i] as number;
    if (r <= 0) return kept[i] as number;
  }
  return kept[kept.length - 1] as number;
}
