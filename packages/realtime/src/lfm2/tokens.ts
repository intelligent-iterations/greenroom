import { AUDIO_START_TOKEN, CODEBOOK_VOCAB, END_OF_AUDIO, NUM_CODEBOOKS,
  MAX_AUDIO_CODE,
} from './config.js';

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

/**
 * The frame that ends the spoken segment.
 *
 * Codebook zero, matching the reference loop. This used to test every codebook,
 * which reads like the more careful choice and is not: the residual codebooks
 * occasionally carry 2048 in the middle of speech, and treating that as the end
 * truncates the reply — sometimes to nothing at all. Those frames are dropped
 * by `carriesEndMarker` rather than ending the turn.
 */
export function isEndOfAudio(frameCodes: readonly number[]): boolean {
  return frameCodes[0] === END_OF_AUDIO;
}

/**
 * Clamp a frame into the range the detokenizer can actually decode.
 *
 * A residual codebook sometimes carries 2048 mid-utterance. It is a valid input
 * to the audio embedding — the codebook vocabulary is 2049 wide — but it is not
 * a waveform, and the detokenizer has no code for it. The reference clips to
 * 0..2047 before decoding, which keeps the frame and its timing; dropping it
 * would leave a hole in the audio.
 */
export function clampAudioCodes(frameCodes: readonly number[]): number[] {
  return frameCodes.map((code) => (code > MAX_AUDIO_CODE ? MAX_AUDIO_CODE : code < 0 ? 0 : code));
}

export function isAudioStart(token: number): boolean {
  return token === AUDIO_START_TOKEN;
}

/**
 * The chat format the model was trained on, from the model card.
 *
 * Returned in two halves, and that is the point of it.
 *
 * The speech the model is answering is not text — it arrives as encoder
 * embeddings, which have no token ids and so cannot be interpolated into a
 * string. They have to be spliced into the embedding sequence *between* these
 * halves, so the audio occupies the user turn.
 *
 * Getting that wrong is not a subtle degradation. Appending the audio after the
 * whole prompt puts it past `<|im_start|>assistant`, so the model reads the
 * user's speech as the opening of its own reply and simply continues it: the
 * output is fluent, unrelated, and never switches to audio, because the model
 * does not believe anyone has asked it anything. Observed as several hundred
 * words about football tournaments in reply to a room with nobody talking.
 *
 * Written out rather than assembled from a template helper so the exact
 * newlines are visible: they are part of the format, and a missing one shifts
 * every token after it.
 */
export interface PromptHalves {
  /** Everything up to and including the start of the user's turn. */
  prefix: string;
  /** Closes the user's turn and opens the assistant's. */
  suffix: string;
}

export function buildPrompt(options: { system: string; user?: string }): PromptHalves {
  return {
    prefix:
      '<|startoftext|><|im_start|>system\n' +
      options.system +
      '<|im_end|>\n<|im_start|>user\n' +
      (options.user ?? ''),
    suffix: '<|im_end|>\n<|im_start|>assistant\n',
  };
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
