import { describe, expect, it } from 'vitest';
import { LfmAudioStage } from '../lfm2/stage.js';
import {
  AUDIO_START_TOKEN,
  END_OF_AUDIO,
  HIDDEN_SIZE,
  INPUT_SAMPLE_RATE,
  NUM_CODEBOOKS,
  TEXT_VOCAB,
} from '../lfm2/config.js';
import type { SessionLike, TensorData, TensorLike } from '../lfm2/runtime.js';

/**
 * How the stage behaves when turns collide, and what it does with a microphone
 * nobody is endpointing.
 *
 * Nothing here tests the maths — that is lfm2-generate.test.ts. This is the
 * part that broke a real conversation on the first attempt: an endpoint
 * detector fires every few seconds, a turn takes longer than that, and two
 * generations end up running over one mutable DecoderCache. In the browser that
 * surfaced as `RuntimeError: memory access out of bounds`, which names neither
 * the cache nor the overlap — so it is worth pinning down here, where the
 * failure is legible.
 */

const tensor = (type: string, data: TensorData, dims: readonly number[]): TensorLike => ({
  type,
  data,
  dims,
});
const factory = tensor as never;

/**
 * The embedding table, allocated once for the whole file.
 *
 * TextEmbeddings insists on exactly 65536 x 2048 floats, so this is half a
 * gigabyte. Per-test it was the slowest thing here by an order of magnitude.
 */
let table: ArrayBuffer | undefined;
const embedTable = (): ArrayBuffer => (table ??= new ArrayBuffer(TEXT_VOCAB * HIDDEN_SIZE * 4));

/**
 * A decoder that switches to audio immediately, so a turn is two steps.
 *
 * Generation leaves text mode only on AUDIO_START_TOKEN and leaves the loop
 * only when the depthformer returns end-of-audio. A fake that emits neither
 * runs to maxSteps, which is a slow way to discover you wrote the fake wrong.
 */
function fakeDecoder(options: { delayMs?: number; onRun?: () => void } = {}): SessionLike {
  return {
    inputNames: ['inputs_embeds', 'attention_mask', 'past_conv.0', 'past_key_values.2.key'],
    outputNames: ['logits', 'hidden_states'],
    run: async (feeds) => {
      options.onRun?.();
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      const seq = (feeds['inputs_embeds']?.dims[1] ?? 1) as number;
      const logits = new Float32Array(seq * TEXT_VOCAB);
      logits[(seq - 1) * TEXT_VOCAB + AUDIO_START_TOKEN] = 100;
      return {
        logits: tensor('float32', logits, [1, seq, TEXT_VOCAB]),
        hidden_states: tensor('float32', new Float32Array(seq * HIDDEN_SIZE), [
          1,
          seq,
          HIDDEN_SIZE,
        ]),
        'present_conv.0': tensor('float32', new Float32Array(HIDDEN_SIZE * 3), [1, HIDDEN_SIZE, 3]),
        'present.2.key': tensor('float32', new Float32Array(0), [1, 8, 0, 64]),
      };
    },
  };
}

/** Everything else: a depthformer that ends the audio at once, and stubs. */
const supporting: SessionLike = {
  inputNames: [],
  outputNames: [],
  run: async () => {
    const logits = new Float32Array(2049);
    logits[END_OF_AUDIO] = 100;
    return {
      audio_embeddings: tensor('float32', new Float32Array(HIDDEN_SIZE), [1, 1, HIDDEN_SIZE]),
      logits: tensor('float32', logits, [1, 2049]),
      depth_slices: tensor('float32', new Float32Array(NUM_CODEBOOKS * 1024), [
        1,
        NUM_CODEBOOKS,
        1024,
      ]),
      new_keys: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
      new_values: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
      audio_embeds: tensor('float32', new Float32Array(NUM_CODEBOOKS * HIDDEN_SIZE), [
        1,
        NUM_CODEBOOKS,
        HIDDEN_SIZE,
      ]),
      stft_features: tensor('float32', new Float32Array(1282), [1, 1, 1282]),
    };
  },
};

function build(decoder: SessionLike, encoder: SessionLike = supporting): LfmAudioStage {
  return new LfmAudioStage({
    assets: {
      session: async (name) => {
        if (name.startsWith('decoder')) return decoder;
        if (name.startsWith('audio_encoder')) return encoder;
        return supporting;
      },
      bytes: async () => embedTable(),
    },
    tensor: factory,
    encode: () => [1, 2, 3],
    decode: () => 'x',
  });
}

async function loadedStage(decoder: SessionLike): Promise<LfmAudioStage> {
  const stage = build(decoder);
  await stage.load();
  await stage.open();
  return stage;
}

const speech = (seconds: number) => ({
  samples: new Float32Array(INPUT_SAMPLE_RATE * seconds),
  sampleRate: INPUT_SAMPLE_RATE,
});
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LfmAudioStage turn concurrency', () => {
  it('never runs two turns at once', async () => {
    let concurrent = 0;
    let peak = 0;
    let runs = 0;
    const decoder: SessionLike = {
      inputNames: ['inputs_embeds', 'attention_mask'],
      outputNames: ['logits', 'hidden_states'],
      run: async (feeds) => {
        concurrent += 1;
        runs += 1;
        peak = Math.max(peak, concurrent);
        await tick(15);
        concurrent -= 1;
        const seq = (feeds['inputs_embeds']?.dims[1] ?? 1) as number;
        const logits = new Float32Array(seq * TEXT_VOCAB);
        logits[(seq - 1) * TEXT_VOCAB + AUDIO_START_TOKEN] = 100;
        return {
          logits: tensor('float32', logits, [1, seq, TEXT_VOCAB]),
          hidden_states: tensor('float32', new Float32Array(seq * HIDDEN_SIZE), [
            1,
            seq,
            HIDDEN_SIZE,
          ]),
        };
      },
    };

    const stage = await loadedStage(decoder);

    // Three endpoints arriving while the previous turn is still going — what a
    // 768ms silence threshold does to someone speaking in short bursts.
    stage.send(speech(1));
    const a = stage.respond();
    await tick(5);
    stage.send(speech(1));
    const b = stage.respond();
    await tick(5);
    stage.send(speech(1));
    const c = stage.respond();
    await Promise.all([a, b, c]);

    expect(runs).toBeGreaterThan(1);
    expect(peak).toBe(1);
    await stage.close();
  }, 20_000);

  it('waits for the running turn to stop before starting the next', async () => {
    const order: string[] = [];
    const stage = await loadedStage(
      fakeDecoder({ delayMs: 20, onRun: () => order.push('decoder') }),
    );

    stage.send(speech(1));
    const first = stage.respond().then(() => order.push('first-done'));
    await tick(5);
    stage.send(speech(1));
    const second = stage.respond().then(() => order.push('second-done'));
    await Promise.all([first, second]);

    // No decoder work from the second turn before the first had finished.
    expect(order.indexOf('first-done')).toBeLessThan(order.lastIndexOf('decoder'));
    expect(order[order.length - 1]).toBe('second-done');
    await stage.close();
  }, 20_000);

  it('reports busy while a turn is generating', async () => {
    const stage = await loadedStage(fakeDecoder({ delayMs: 20 }));
    expect(stage.busy).toBe(false);

    stage.send(speech(1));
    const turn = stage.respond();
    expect(stage.busy).toBe(true);

    await turn;
    expect(stage.busy).toBe(false);
    await stage.close();
  }, 20_000);

  it('is not busy after a turn throws', async () => {
    // A stage stuck reporting busy goes permanently deaf: the caller skips
    // respond() while busy, so a leaked flag ends the conversation in silence.
    const stage = await loadedStage({
      inputNames: ['inputs_embeds'],
      outputNames: ['logits'],
      run: async () => {
        throw new Error('gpu lost');
      },
    });

    stage.send(speech(1));
    await stage.respond();
    expect(stage.busy).toBe(false);
    await stage.close();
  }, 20_000);
});

describe('LfmAudioStage microphone buffer', () => {
  /** A stage whose encoder records how many mel frames it was handed. */
  async function recordingStage(): Promise<{ stage: LfmAudioStage; frames: () => number }> {
    let melFrames = 0;
    const encoder: SessionLike = {
      inputNames: ['mel_spectrogram', 'mel_lengths'],
      outputNames: ['audio_embeddings'],
      run: async (feeds) => {
        melFrames = (feeds['mel_spectrogram']?.dims[1] ?? 0) as number;
        return {
          audio_embeddings: tensor('float32', new Float32Array(HIDDEN_SIZE), [1, 1, HIDDEN_SIZE]),
        };
      },
    };
    const stage = build(fakeDecoder(), encoder);
    await stage.load();
    await stage.open();
    return { stage, frames: () => melFrames };
  }

  it('caps what an unendpointed microphone accumulates', async () => {
    // An open mic that never triggers an endpoint used to buffer without limit,
    // and the first turn then handed the encoder however long had gone by. At a
    // 10ms hop two minutes is 12,000 mel frames, and attention is quadratic in
    // that.
    const { stage, frames } = await recordingStage();
    for (let i = 0; i < 90; i++) stage.send(speech(1));
    await stage.respond();

    expect(frames()).toBeGreaterThan(0);
    // 30 seconds at a 10ms hop, with a little room for the window's tail.
    expect(frames()).toBeLessThanOrEqual(3100);
    await stage.close();
  }, 60_000);

  it('keeps an ordinary utterance whole', async () => {
    // The cap must not clip real speech: five seconds arrives intact.
    const { stage, frames } = await recordingStage();
    stage.send(speech(5));
    await stage.respond();

    expect(frames()).toBeGreaterThan(400);
    expect(frames()).toBeLessThan(600);
    await stage.close();
  }, 30_000);

  it('empties the buffer once a turn has consumed it', async () => {
    // Audio must not be replayed into the next turn — that is how the same
    // utterance gets answered twice.
    const { stage, frames } = await recordingStage();
    stage.send(speech(5));
    await stage.respond();
    const first = frames();

    stage.send(speech(1));
    await stage.respond();
    expect(frames()).toBeLessThan(first);
    await stage.close();
  }, 30_000);
});

describe('LfmAudioStage prompt assembly', () => {
  it('places the encoded speech between the user header and the assistant one', async () => {
    // The defect this pins: audio appended after the whole prompt sits past
    // `<|im_start|>assistant`, so the model continues the user's speech as its
    // own reply instead of answering it — fluent, unrelated, and never audio.
    //
    // Encoder embeddings carry no token ids, so the only way to check where
    // they landed is to make them a value nothing else uses and find it.
    const MARK = 7.5;
    const encoder: SessionLike = {
      inputNames: ['mel_spectrogram', 'mel_lengths'],
      outputNames: ['audio_embeddings'],
      run: async () => ({
        audio_embeddings: tensor('float32', new Float32Array(HIDDEN_SIZE * 2).fill(MARK), [
          1,
          2,
          HIDDEN_SIZE,
        ]),
      }),
    };

    let promptLength = 0;
    let audioAt = -1;
    const decoder: SessionLike = {
      inputNames: ['inputs_embeds', 'attention_mask'],
      outputNames: ['logits', 'hidden_states'],
      run: async (feeds) => {
        const embeds = feeds['inputs_embeds'] as TensorLike;
        const seq = embeds.dims[1] as number;
        if (audioAt === -1) {
          promptLength = seq;
          const data = embeds.data as Float32Array;
          for (let p = 0; p < seq; p++) {
            if (data[p * HIDDEN_SIZE] === MARK) {
              audioAt = p;
              break;
            }
          }
        }
        const logits = new Float32Array(seq * TEXT_VOCAB);
        logits[(seq - 1) * TEXT_VOCAB + AUDIO_START_TOKEN] = 100;
        return {
          logits: tensor('float32', logits, [1, seq, TEXT_VOCAB]),
          hidden_states: tensor('float32', new Float32Array(seq * HIDDEN_SIZE), [
            1,
            seq,
            HIDDEN_SIZE,
          ]),
        };
      },
    };

    // encode() returns one id per character, so the halves have known lengths.
    const stage = new LfmAudioStage({
      assets: {
        session: async (name) => {
          if (name.startsWith('decoder')) return decoder;
          if (name.startsWith('audio_encoder')) return encoder;
          return supporting;
        },
        bytes: async () => embedTable(),
      },
      tensor: factory,
      encode: (text) => [...text].map(() => 1),
      decode: () => 'x',
      systemPrompt: 'S',
    });
    await stage.load();
    await stage.open();
    stage.send(speech(1));
    await stage.respond();

    const prefixLength = '<|startoftext|><|im_start|>system\nS<|im_end|>\n<|im_start|>user\n'.length;
    const suffixLength = '<|im_end|>\n<|im_start|>assistant\n'.length;

    expect(audioAt).toBe(prefixLength);
    // And the assistant header follows the audio rather than preceding it.
    expect(promptLength).toBe(prefixLength + 2 + suffixLength);
    await stage.close();
  }, 20_000);
});

describe('LfmAudioStage sampling', () => {
  it('does not decode text greedily by default', async () => {
    // Pure argmax degenerates on this model: one good sentence, then
    // encyclopedia fragments repeated to the step limit. The temperature
    // option existed in generate() and nothing could reach it, so text
    // decoding was always greedy no matter what a caller asked for.
    //
    // Proven by making the choice observable: two tokens sit close together in
    // the logits, and a rigged random always takes the *second* of the top-k.
    // Under argmax the emitted token can only ever be the larger one.
    const RUNNER_UP = 4242;
    const decoder: SessionLike = {
      inputNames: ['inputs_embeds'],
      outputNames: ['logits', 'hidden_states'],
      run: async (feeds) => {
        const seq = (feeds['inputs_embeds']?.dims[1] ?? 1) as number;
        const logits = new Float32Array(seq * TEXT_VOCAB);
        const row = (seq - 1) * TEXT_VOCAB;
        logits[row + AUDIO_START_TOKEN] = 10;
        logits[row + RUNNER_UP] = 9.9;
        return {
          logits: tensor('float32', logits, [1, seq, TEXT_VOCAB]),
          hidden_states: tensor('float32', new Float32Array(seq * HIDDEN_SIZE), [
            1,
            seq,
            HIDDEN_SIZE,
          ]),
        };
      },
    };

    const emitted: number[] = [];
    const stage = new LfmAudioStage({
      assets: {
        session: async (name) => (name.startsWith('decoder') ? decoder : supporting),
        bytes: async () => embedTable(),
      },
      tensor: factory,
      encode: () => [1, 2, 3],
      decode: (tokens) => {
        emitted.push(...tokens);
        return 'x';
      },
      // Always land in the tail of the distribution, never on the mode.
      random: () => 0.999999,
      maxSteps: 1,
    });
    await stage.load();
    await stage.open();
    stage.send(speech(1));
    await stage.respond();

    // Greedy would have taken AUDIO_START_TOKEN, switched to audio mode, and
    // emitted no text at all. Which token sampling lands on is not the point —
    // that it sampled at all is.
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).not.toContain(AUDIO_START_TOKEN);
    await stage.close();
  }, 20_000);

  it('lets a caller pin text decoding back to greedy', async () => {
    const decoder: SessionLike = {
      inputNames: ['inputs_embeds'],
      outputNames: ['logits', 'hidden_states'],
      run: async (feeds) => {
        const seq = (feeds['inputs_embeds']?.dims[1] ?? 1) as number;
        const logits = new Float32Array(seq * TEXT_VOCAB);
        const row = (seq - 1) * TEXT_VOCAB;
        logits[row + AUDIO_START_TOKEN] = 10;
        logits[row + 4242] = 9.9;
        return {
          logits: tensor('float32', logits, [1, seq, TEXT_VOCAB]),
          hidden_states: tensor('float32', new Float32Array(seq * HIDDEN_SIZE), [
            1,
            seq,
            HIDDEN_SIZE,
          ]),
        };
      },
    };

    const emitted: number[] = [];
    const stage = new LfmAudioStage({
      assets: {
        session: async (name) => (name.startsWith('decoder') ? decoder : supporting),
        bytes: async () => embedTable(),
      },
      tensor: factory,
      encode: () => [1, 2, 3],
      decode: (tokens) => {
        emitted.push(...tokens);
        return 'x';
      },
      random: () => 0.999999,
      textTemperature: 0,
      maxSteps: 1,
    });
    await stage.load();
    await stage.open();
    stage.send(speech(1));
    await stage.respond();

    // The mode wins, so it switched to audio and emitted no text.
    expect(emitted).not.toContain(4242);
    await stage.close();
  }, 20_000);
});

describe('LfmAudioStage shutdown', () => {
  it('close() waits for a turn still running', async () => {
    // Releasing GPU sessions while a turn is mid-run is a use-after-free.
    let finished = false;
    const stage = await loadedStage(fakeDecoder({ delayMs: 25 }));

    stage.send(speech(1));
    const turn = stage.respond().then(() => (finished = true));
    await tick(5);
    await stage.close();

    expect(finished).toBe(true);
    await turn;
  }, 20_000);

  it('ignores audio sent after close', async () => {
    const stage = await loadedStage(fakeDecoder());
    await stage.close();
    stage.send(speech(1));
    await stage.respond();
    expect(stage.busy).toBe(false);
  }, 20_000);
});
