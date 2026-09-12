import type { SessionLike, TensorFactory, TensorLike } from './runtime.js';
import { ATTENTION_HEADS, CONV_CACHE_WIDTH, HEAD_DIM, HIDDEN_SIZE } from './config.js';

/**
 * The decoder's hybrid cache.
 *
 * LFM2 interleaves two kinds of block, and the graph signature shows it plainly:
 * ten blocks carry a short convolution state shaped [1, 2048, 3], and six carry
 * attention keys and values shaped [1, 8, past, 64]. Which index is which is not
 * a pattern to infer — it is read from `session.inputNames`, so a different
 * checkpoint with a different arrangement works without changing this file.
 *
 * Convolution state starts as zeros and keeps a fixed width forever; attention
 * state starts empty and grows by one position per step. Initialising a
 * convolution slot as empty, or an attention slot as zeros, produces a model
 * that runs and talks nonsense.
 */
export class DecoderCache {
  #entries = new Map<string, TensorLike>();
  #tensor: TensorFactory;

  constructor(session: SessionLike, tensor: TensorFactory) {
    this.#tensor = tensor;
    for (const name of session.inputNames) {
      if (name.startsWith('past_conv')) {
        this.#entries.set(
          name,
          tensor('float32', new Float32Array(HIDDEN_SIZE * CONV_CACHE_WIDTH), [
            1,
            HIDDEN_SIZE,
            CONV_CACHE_WIDTH,
          ]),
        );
      } else if (name.startsWith('past_key_values')) {
        // Zero-length: there is no history yet, and a zeroed slot of nonzero
        // length would be attended to as if it were real context.
        this.#entries.set(
          name,
          tensor('float32', new Float32Array(0), [1, ATTENTION_HEADS, 0, HEAD_DIM]),
        );
      }
    }
  }

  /** The cache inputs, ready to spread into a `run` call. */
  feeds(): Record<string, TensorLike> {
    return Object.fromEntries(this.#entries);
  }

  /**
   * Carry the step's outputs forward.
   *
   * `present_conv.N` becomes `past_conv.N`, and `present.N.key` becomes
   * `past_key_values.N.key`. The two prefixes differ in shape, which is why the
   * rename is explicit rather than a single string replacement.
   */
  update(outputs: Record<string, TensorLike>): void {
    for (const [name, tensor] of Object.entries(outputs)) {
      if (name.startsWith('present_conv')) {
        this.#entries.set(name.replace('present_conv', 'past_conv'), tensor);
      } else if (name.startsWith('present.')) {
        this.#entries.set(name.replace('present.', 'past_key_values.'), tensor);
      }
    }
  }

  /** Number of cached slots, for tests and diagnostics. */
  get size(): number {
    return this.#entries.size;
  }

  reset(session: SessionLike): void {
    this.#entries.clear();
    const fresh = new DecoderCache(session, this.#tensor);
    this.#entries = new Map(Object.entries(fresh.feeds()));
  }
}
