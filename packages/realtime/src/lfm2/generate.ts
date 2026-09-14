import {
  AUDIO_START_TOKEN,
  CODEBOOK_VOCAB,
  END_OF_TEXT_TOKEN,
  IM_END_TOKEN,
  REFERENCE_AUDIO_TEMPERATURE,
  REFERENCE_AUDIO_TOP_K,
  REFERENCE_TEXT_TEMPERATURE,
  TEXT_END_TOKEN,
  TEXT_START_TOKEN,
  DEPTHFORMER_HEADS,
  DEPTHFORMER_HEAD_DIM,
  DEPTHFORMER_LAYERS,
  DEPTH_SLICE_WIDTH,
  HIDDEN_SIZE,
  NUM_CODEBOOKS,
  TEXT_VOCAB,
} from './config.js';
import { DecoderCache } from './cache.js';
import type { SessionLike, TensorFactory, TensorLike } from './runtime.js';
import {
  argmax,
  audioTokenIds,
  clampAudioCodes,
  isEndOfAudio,
  sampleTopK,
  sumCodebookEmbeddings,
} from './tokens.js';

/**
 * The interleaved text/audio generation loop.
 *
 * Two nested autoregressions, which is the thing to hold in mind while reading
 * this. The outer one is the LFM2 backbone producing one position per step. The
 * inner one is a six-layer depth transformer producing the eight residual
 * codebooks *within* a single audio frame — so an audio frame costs one backbone
 * step plus eight depthformer steps, and every 80ms of speech is nine forward
 * passes.
 *
 * The model starts in text mode and switches when it emits `<|audio_start|>`
 * (token 128). After that each step is a frame, fed back as the sum of its eight
 * codebook embeddings, until a codebook comes back 2048.
 */

export interface GenerationSessions {
  decoder: SessionLike;
  depthformer: SessionLike;
  audioEmbedding: SessionLike;
}

export interface GenerationOptions {
  maxSteps?: number;
  /**
   * Called once per step to release the event loop. See the loop body.
   *
   * Injected rather than hardcoded so tests run at full speed and a caller on
   * a worker thread, which does not need it, can leave it out.
   */
  yield?: () => Promise<void>;
  /** Greedy by default: text that wanders is worse than text that is dull. */
  textTemperature?: number;
  /** Audio wants sampling; greedy audio is flat and buzzy. */
  audioTemperature?: number;
  audioTopK?: number;
  random?: () => number;
  signal?: AbortSignal;
}

export interface GenerationHandlers {
  /** A text token was produced. */
  onText?(token: number): void;
  /** One 80ms frame of audio codes, ready for the detokenizer. */
  onAudioFrame?(codes: number[]): void;
  /**
   * The turn is over, with the two numbers that explain a silent one.
   *
   * "No audio came out" has two quite different causes — the model never left
   * text mode, or it switched and produced nothing — and they need different
   * fixes. Reported rather than logged, so a caller decides what to do with it.
   */
  onDone?(summary: { steps: number; frames: number; reachedAudio: boolean }): void;
}

/**
 * Turns a text token into its embedding row.
 *
 * Passed in rather than owned because the table is 512MB and belongs to
 * whatever loaded it — and because a module-level lookup would be shared by
 * every concurrent session, which is a bug waiting for a second tab.
 */
export type TextLookup = (token: number) => Float32Array;

/** Embedding lookup for text tokens, from the raw embed_tokens.bin table. */
export class TextEmbeddings {
  #weights: Float32Array;
  #hidden: number;

  constructor(buffer: ArrayBuffer, hidden = HIDDEN_SIZE) {
    this.#weights = new Float32Array(buffer);
    this.#hidden = hidden;
    const expected = TEXT_VOCAB * hidden;
    if (this.#weights.length !== expected) {
      // Caught here rather than as a wrong-shaped tensor three calls later.
      throw new Error(
        `embed_tokens.bin has ${this.#weights.length} floats, expected ${expected}`,
      );
    }
  }

  lookup(ids: readonly number[]): Float32Array {
    const out = new Float32Array(ids.length * this.#hidden);
    ids.forEach((id, i) => {
      const from = id * this.#hidden;
      out.set(this.#weights.subarray(from, from + this.#hidden), i * this.#hidden);
    });
    return out;
  }
}

/**
 * Generate the eight codebooks for one audio frame.
 *
 * The depthformer carries its own small cache across the eight steps and is
 * reset for each frame: its sequence is the codebook axis, not time. Reusing
 * the previous frame's cache here would make every frame after the first depend
 * on the one before through the wrong axis.
 */
export async function generateAudioFrame(
  depthformer: SessionLike,
  hidden: Float32Array,
  tensor: TensorFactory,
  options: GenerationOptions = {},
): Promise<number[]> {
  const temperature = options.audioTemperature ?? REFERENCE_AUDIO_TEMPERATURE;
  const topK = options.audioTopK ?? REFERENCE_AUDIO_TOP_K;

  let depthSlices = tensor('float32', new Float32Array(NUM_CODEBOOKS * DEPTH_SLICE_WIDTH), [
    1,
    NUM_CODEBOOKS,
    DEPTH_SLICE_WIDTH,
  ]);
  // Allocated at full width, once, and never regrown.
  //
  // `seqlens_k` and `total_seq_len` are ONNX Runtime's GroupQueryAttention
  // inputs, and that operator's contract is a cache big enough for the whole
  // sequence which it updates *in place*, with seqlens_k saying how much of it
  // is real. Growing a cache from zero the way the decoder's does is the wrong
  // shape of idea entirely, and ORT says so on the very first codebook:
  //
  //   Shape mismatch attempting to re-use buffer. {1,8,0,32} != {1,8,1,32}
  //
  // Every audio frame failed there, so the model never produced a sound — and
  // because the failure was inside a turn, it surfaced as an error banner
  // rather than as silence with a cause.
  //
  // The sequence here is the codebook axis, not time, so its full width is
  // exactly NUM_CODEBOOKS.
  const cacheSize =
    DEPTHFORMER_LAYERS * DEPTHFORMER_HEADS * NUM_CODEBOOKS * DEPTHFORMER_HEAD_DIM;
  const cacheDims = [
    DEPTHFORMER_LAYERS,
    1,
    DEPTHFORMER_HEADS,
    NUM_CODEBOOKS,
    DEPTHFORMER_HEAD_DIM,
  ];
  let pastKeys = tensor('float32', new Float32Array(cacheSize), cacheDims);
  let pastValues = tensor('float32', new Float32Array(cacheSize), cacheDims);

  const codes: number[] = [];
  let previous = 0;

  for (let step = 0; step < NUM_CODEBOOKS; step++) {
    const outputs = await depthformer.run({
      hidden_states: tensor('float32', hidden, [1, HIDDEN_SIZE]),
      depth_slices_in: depthSlices,
      step_idx: tensor('int64', BigInt64Array.from([BigInt(step)]), []),
      prev_token: tensor('int64', BigInt64Array.from([BigInt(previous)]), [1]),
      past_keys: pastKeys,
      past_values: pastValues,
      seqlens_k: tensor('int32', Int32Array.from([step]), [1]),
      total_seq_len: tensor('int32', Int32Array.from([step + 1]), []),
    });

    const logits = outputs['logits']?.data as Float32Array;
    // 2049 wide: 2048 audio codes plus end-of-audio.
    const code = sampleTopK(logits, 0, CODEBOOK_VOCAB, temperature, topK, options.random);
    codes.push(code);
    previous = code;

    // Handed straight back: GroupQueryAttention writes into the cache it was
    // given, so these are the same buffers and copying them would only throw
    // the update away.
    //
    // The ones being replaced are released first. Eight codebooks per frame
    // and several hundred frames per reply is a few thousand runs, each
    // producing four tensors; holding them all is what exhausted the heap
    // partway through the first long turn.
    const nextSlices = outputs['depth_slices'] as TensorLike;
    const nextKeys = outputs['new_keys'] as TensorLike;
    const nextValues = outputs['new_values'] as TensorLike;
    release(outputs['logits'] as TensorLike);
    if (depthSlices !== nextSlices) release(depthSlices);
    if (pastKeys !== nextKeys) release(pastKeys);
    if (pastValues !== nextValues) release(pastValues);
    depthSlices = nextSlices;
    pastKeys = nextKeys;
    pastValues = nextValues;
  }

  release(depthSlices);
  release(pastKeys);
  release(pastValues);
  return codes;
}

/** Free a tensor if its implementation can, ignoring one that cannot. */
function release(tensor: TensorLike | undefined): void {
  try {
    tensor?.dispose?.();
  } catch {
    // Already released, or a double that has no buffer. Neither is a problem.
  }
}


/**
 * Run the backbone until the turn ends.
 *
 * `promptEmbeds` is the whole prompt on the first call; afterwards one position
 * at a time. `pastLength` tracks how much history the attention mask has to
 * cover — the mask is over *total* sequence length, not over the step.
 */
export async function generate(
  sessions: GenerationSessions,
  cache: DecoderCache,
  promptEmbeds: Float32Array,
  promptLength: number,
  tensor: TensorFactory,
  textLookup: TextLookup,
  handlers: GenerationHandlers = {},
  options: GenerationOptions = {},
): Promise<{ steps: number; frames: number }> {
  // The reference caps an interleaved turn at 300. A conversational reply that
  // has not finished by then is not going to.
  const maxSteps = options.maxSteps ?? 300;
  let embeds = tensor('float32', promptEmbeds, [1, promptLength, HIDDEN_SIZE]);
  let total = promptLength;
  let inAudioMode = false;
  let frames = 0;
  let steps = 0;

  for (; steps < maxSteps; steps++) {
    if (options.signal?.aborted) break;

    // Hand the event loop back between steps.
    //
    // ONNX Runtime's WebGPU path is single-threaded glue on the main thread,
    // and awaiting it only yields microtasks — which never let the browser
    // paint, never deliver a click, and never let a scheduled AudioBuffer
    // start. A three hundred step reply therefore froze the tab solid for
    // minutes and the audio it had already produced stayed silent until the
    // end. A macrotask each step gives back control; it costs well under a
    // millisecond against a step that costs tens.
    await options.yield?.();

    const outputs = await sessions.decoder.run({
      inputs_embeds: embeds,
      attention_mask: tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
      ...cache.feeds(),
    });
    cache.update(outputs);

    const hiddenTensor = outputs['hidden_states'] as TensorLike;
    const sequence = hiddenTensor.dims[1] as number;
    // Only the final position matters; on the first step the prompt contributes
    // many, and reading position 0 would condition everything on the first token.
    const lastHidden = (hiddenTensor.data as Float32Array).slice(
      (sequence - 1) * HIDDEN_SIZE,
      sequence * HIDDEN_SIZE,
    );

    if (inAudioMode) {
      const codes = await generateAudioFrame(sessions.depthformer, lastHidden, tensor, options);
      if (isEndOfAudio(codes)) break;

      // Clamped on the way out, raw on the way back in. A residual codebook
      // carrying 2048 is a legal embedding input — the vocabulary is 2049 wide
      // — but not a waveform, so the reference clips before decoding. Dropping
      // the frame instead would leave a hole in the audio.
      handlers.onAudioFrame?.(clampAudioCodes(codes));
      frames += 1;

      const ids = audioTokenIds(codes);
      const embedded = await sessions.audioEmbedding.run({
        audio_codes: tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, NUM_CODEBOOKS]),
      });
      // The residual codebooks are additive refinements, so the frame's
      // representation is their sum, not a concatenation.
      const summed = sumCodebookEmbeddings(
        embedded['audio_embeds']?.data as Float32Array,
        HIDDEN_SIZE,
      );
      embeds = tensor('float32', summed, [1, 1, HIDDEN_SIZE]);
    } else {
      const logits = outputs['logits']?.data as Float32Array;
      const vocabOffset = (sequence - 1) * TEXT_VOCAB;
      const temperature = options.textTemperature ?? REFERENCE_TEXT_TEMPERATURE;
      const token =
        temperature > 0
          ? sampleTopK(logits, vocabOffset, TEXT_VOCAB, temperature, 50, options.random)
          : argmax(logits, vocabOffset, TEXT_VOCAB);

      // The turn is over. Without this the loop had no stop condition but the
      // step limit, so every reply ran on until it exhausted it.
      if (token === IM_END_TOKEN || token === END_OF_TEXT_TOKEN) break;

      if (token === AUDIO_START_TOKEN) {
        inAudioMode = true;
      } else if (token !== TEXT_START_TOKEN && token !== TEXT_END_TOKEN) {
        // The text markers are structure, not words. Emitting them puts
        // "<|text_end|>" in front of a person, or through a synthesiser.
        handlers.onText?.(token);
      }

      // The switch token is fed back like any other: it is part of the sequence
      // the model conditioned on, and skipping it desynchronises the cache
      // against the attention mask.
      embeds = tensor('float32', textLookup(token), [1, 1, HIDDEN_SIZE]);
    }

    total += 1;
  }

  // One line per turn. A reply that produced no audio is the failure this
  // whole path kept having, and the two numbers that distinguish its causes —
  // never switched modes, or switched and generated nothing — are these.
  handlers.onDone?.({ steps, frames, reachedAudio: inAudioMode });
  return { steps, frames };
}
