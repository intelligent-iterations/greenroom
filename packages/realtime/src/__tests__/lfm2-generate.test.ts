import { describe, expect, it, vi } from 'vitest';
import { DecoderCache } from '../lfm2/cache.js';
import { TextEmbeddings, generate, generateAudioFrame } from '../lfm2/generate.js';
import type { SessionLike, TensorLike, TensorData } from '../lfm2/runtime.js';
import {
  AUDIO_START_TOKEN,
  END_OF_AUDIO,
  END_OF_TEXT_TOKEN,
  HIDDEN_SIZE,
  IM_END_TOKEN,
  NUM_CODEBOOKS,
  TEXT_END_TOKEN,
  TEXT_START_TOKEN,
  TEXT_VOCAB,
} from '../lfm2/config.js';

const tensor = (type: string, data: TensorData, dims: readonly number[]): TensorLike => ({
  type,
  data,
  dims,
});
const factory = tensor as never;

/** A decoder whose emitted tokens the test dictates. */
function fakeDecoder(script: number[]): SessionLike & { calls: Record<string, TensorLike>[] } {
  let step = 0;
  const calls: Record<string, TensorLike>[] = [];
  return {
    calls,
    inputNames: [
      'inputs_embeds',
      'attention_mask',
      'past_conv.0',
      'past_conv.1',
      'past_key_values.2.key',
      'past_key_values.2.value',
      'past_conv.3',
    ],
    outputNames: ['logits', 'hidden_states'],
    run: async (feeds) => {
      calls.push(feeds);
      const seq = (feeds['inputs_embeds']?.dims[1] ?? 1) as number;
      const logits = new Float32Array(seq * TEXT_VOCAB);
      const token = script[step] ?? 0;
      step += 1;
      logits[(seq - 1) * TEXT_VOCAB + token] = 100;
      return {
        logits: tensor('float32', logits, [1, seq, TEXT_VOCAB]),
        hidden_states: tensor('float32', new Float32Array(seq * HIDDEN_SIZE), [1, seq, HIDDEN_SIZE]),
        'present_conv.0': tensor('float32', new Float32Array(HIDDEN_SIZE * 3), [1, HIDDEN_SIZE, 3]),
        'present.2.key': tensor('float32', new Float32Array(0), [1, 8, 0, 64]),
      };
    },
  };
}

/** A depthformer that returns a fixed code in every codebook. */
function fakeDepthformer(code: number): SessionLike {
  return {
    inputNames: [],
    outputNames: [],
    run: async () => {
      const logits = new Float32Array(2049);
      logits[code] = 100;
      return {
        logits: tensor('float32', logits, [1, 2049]),
        depth_slices: tensor('float32', new Float32Array(NUM_CODEBOOKS * 1024), [1, NUM_CODEBOOKS, 1024]),
        new_keys: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
        new_values: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
      };
    },
  };
}

const fakeAudioEmbedding: SessionLike = {
  inputNames: ['audio_codes'],
  outputNames: ['audio_embeds'],
  run: async () => ({
    audio_embeds: tensor('float32', new Float32Array(NUM_CODEBOOKS * HIDDEN_SIZE).fill(1), [
      1,
      NUM_CODEBOOKS,
      HIDDEN_SIZE,
    ]),
  }),
};

const lookup = () => new Float32Array(HIDDEN_SIZE);

describe('DecoderCache', () => {
  it('initialises conv slots with zeros and attention slots empty', () => {
    // Not interchangeable: a zeroed attention slot of nonzero length would be
    // attended to as if it were real context.
    const decoder = fakeDecoder([]);
    const cache = new DecoderCache(decoder, factory);
    const feeds = cache.feeds();

    expect(feeds['past_conv.0']?.dims).toEqual([1, HIDDEN_SIZE, 3]);
    expect(feeds['past_conv.0']?.data).toHaveLength(HIDDEN_SIZE * 3);
    expect(feeds['past_key_values.2.key']?.dims).toEqual([1, 8, 0, 64]);
    expect(feeds['past_key_values.2.key']?.data).toHaveLength(0);
  });

  it('discovers slots from the graph rather than assuming a layout', () => {
    const cache = new DecoderCache(fakeDecoder([]), factory);
    // 3 conv + 2 attention from the fake's inputNames.
    expect(cache.size).toBe(5);
  });

  it('renames present_ outputs to past_ inputs', () => {
    const cache = new DecoderCache(fakeDecoder([]), factory);
    cache.update({
      'present_conv.0': tensor('float32', new Float32Array(6).fill(7), [1, 2, 3]),
      'present.2.key': tensor('float32', new Float32Array(4).fill(9), [1, 8, 1, 64]),
    });
    expect(cache.feeds()['past_conv.0']?.data[0]).toBe(7);
    expect(cache.feeds()['past_key_values.2.key']?.data[0]).toBe(9);
  });
});

describe('generateAudioFrame', () => {
  it('runs once per codebook and returns one code each', async () => {
    const depthformer = fakeDepthformer(5);
    const run = vi.spyOn(depthformer, 'run');
    const codes = await generateAudioFrame(depthformer, new Float32Array(HIDDEN_SIZE), factory, {
      audioTemperature: 0,
    });
    expect(codes).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
    expect(run).toHaveBeenCalledTimes(NUM_CODEBOOKS);
  });

  it('advances step_idx and the sequence length across codebooks', async () => {
    const depthformer = fakeDepthformer(1);
    const run = vi.spyOn(depthformer, 'run');
    await generateAudioFrame(depthformer, new Float32Array(HIDDEN_SIZE), factory, {
      audioTemperature: 0,
    });
    const steps = run.mock.calls.map((c) => Number((c[0]['step_idx']?.data as BigInt64Array)[0]));
    expect(steps).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const totals = run.mock.calls.map((c) => (c[0]['total_seq_len']?.data as Int32Array)[0]);
    expect(totals).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('feeds each code back as the next prev_token', async () => {
    const depthformer = fakeDepthformer(3);
    const run = vi.spyOn(depthformer, 'run');
    await generateAudioFrame(depthformer, new Float32Array(HIDDEN_SIZE), factory, {
      audioTemperature: 0,
    });
    const prev = run.mock.calls.map((c) => Number((c[0]['prev_token']?.data as BigInt64Array)[0]));
    expect(prev).toEqual([0, 3, 3, 3, 3, 3, 3, 3]);
  });
});

describe('generate', () => {
  it('emits text until the audio-start token', async () => {
    const decoder = fakeDecoder([10, 11, AUDIO_START_TOKEN]);
    const cache = new DecoderCache(decoder, factory);
    const text: number[] = [];

    await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      cache,
      new Float32Array(3 * HIDDEN_SIZE),
      3,
      factory,
      lookup,
      { onText: (t) => text.push(t) },
      { audioTemperature: 0 },
    );

    expect(text).toEqual([10, 11]);
  });

  it('does not report the switch token as text', async () => {
    const decoder = fakeDecoder([AUDIO_START_TOKEN]);
    const text: number[] = [];
    await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(HIDDEN_SIZE),
      1,
      factory,
      lookup,
      { onText: (t) => text.push(t) },
      { audioTemperature: 0 },
    );
    expect(text).toEqual([]);
  });

  it('produces audio frames after the switch and stops on end-of-audio', async () => {
    const decoder = fakeDecoder([AUDIO_START_TOKEN]);
    let frame = 0;
    // Two good frames, then end-of-audio.
    const depthformer: SessionLike = {
      inputNames: [],
      outputNames: [],
      run: async () => {
        const code = frame < 16 ? 7 : END_OF_AUDIO;
        frame += 1;
        const logits = new Float32Array(2049);
        logits[code] = 100;
        return {
          logits: tensor('float32', logits, [1, 2049]),
          depth_slices: tensor('float32', new Float32Array(8 * 1024), [1, 8, 1024]),
          new_keys: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
          new_values: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
        };
      },
    };

    const frames: number[][] = [];
    const result = await generate(
      { decoder, depthformer, audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(HIDDEN_SIZE),
      1,
      factory,
      lookup,
      { onAudioFrame: (c) => frames.push(c) },
      { audioTemperature: 0, maxSteps: 20 },
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
    expect(result.frames).toBe(2);
  });

  it('stops the turn on <|im_end|> instead of running to the step limit', async () => {
    // The defect: the loop had no stop condition but maxSteps, so a reply that
    // was finished after one sentence carried on for hundreds of tokens and
    // never reached the audio it was asked for.
    const decoder = fakeDecoder([200, 201, IM_END_TOKEN, 202, 203]);
    const text: number[] = [];
    const result = await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(4 * HIDDEN_SIZE),
      4,
      factory,
      lookup,
      { onText: (t) => text.push(t) },
      { maxSteps: 50, audioTemperature: 0 },
    );

    expect(text).toEqual([200, 201]);
    expect(result.steps).toBe(2);
  });

  it('stops on <|endoftext|> as well', async () => {
    const decoder = fakeDecoder([200, END_OF_TEXT_TOKEN, 201]);
    const text: number[] = [];
    await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(4 * HIDDEN_SIZE),
      4,
      factory,
      lookup,
      { onText: (t) => text.push(t) },
      { maxSteps: 50, audioTemperature: 0 },
    );
    expect(text).toEqual([200]);
  });

  it('does not hand the text markers to the caller as words', async () => {
    // <|text_start|> and <|text_end|> are structure. Emitted, they reach a
    // transcript and a synthesiser as literal angle brackets.
    const decoder = fakeDecoder([TEXT_START_TOKEN, 200, TEXT_END_TOKEN, IM_END_TOKEN]);
    const text: number[] = [];
    await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(4 * HIDDEN_SIZE),
      4,
      factory,
      lookup,
      { onText: (t) => text.push(t) },
      { maxSteps: 50, audioTemperature: 0 },
    );
    expect(text).toEqual([200]);
  });

  it('grows the attention mask by one position per step', async () => {
    // Ordinary word tokens. 2 is <|endoftext|> and 7 is <|im_end|>, either of
    // which legitimately ends the turn before the third step.
    const decoder = fakeDecoder([200, 201, 202]);
    await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(4 * HIDDEN_SIZE),
      4,
      factory,
      lookup,
      {},
      { maxSteps: 3, audioTemperature: 0 },
    );
    // Prompt of 4, then one per step: the mask covers total sequence length,
    // not the step's own width.
    expect(decoder.calls.map((c) => c['attention_mask']?.dims[1])).toEqual([4, 5, 6]);
  });

  it('feeds one position after the prompt', async () => {
    const decoder = fakeDecoder([1, 2]);
    await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(5 * HIDDEN_SIZE),
      5,
      factory,
      lookup,
      {},
      { maxSteps: 2, audioTemperature: 0 },
    );
    expect(decoder.calls.map((c) => c['inputs_embeds']?.dims[1])).toEqual([5, 1]);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const decoder = fakeDecoder([1, 2, 3]);
    const result = await generate(
      { decoder, depthformer: fakeDepthformer(END_OF_AUDIO), audioEmbedding: fakeAudioEmbedding },
      new DecoderCache(decoder, factory),
      new Float32Array(HIDDEN_SIZE),
      1,
      factory,
      lookup,
      {},
      { signal: controller.signal },
    );
    expect(result.steps).toBe(0);
  });
});

describe('TextEmbeddings', () => {
  it('rejects a table of the wrong size rather than failing later', () => {
    expect(() => new TextEmbeddings(new ArrayBuffer(16))).toThrow(/expected/);
  });

  it('looks up rows by token id', () => {
    const buffer = new ArrayBuffer(TEXT_VOCAB * HIDDEN_SIZE * 4);
    const view = new Float32Array(buffer);
    view[3 * HIDDEN_SIZE] = 42;
    const table = new TextEmbeddings(buffer);
    expect(table.lookup([3])[0]).toBe(42);
    expect(table.lookup([3, 3])).toHaveLength(2 * HIDDEN_SIZE);
  });
});

describe('tensor lifetime', () => {
  it('releases the depthformer tensors it stops using', async () => {
    // Eight codebooks per frame and hundreds of frames per reply is a few
    // thousand runs, each producing four tensors backed by GPU buffers. Held,
    // they exhaust the heap partway through the first long turn and surface as
    // `RuntimeError: memory access out of bounds`, nowhere near this loop.
    let created = 0;
    let disposed = 0;
    const track = (t: TensorLike): TensorLike => {
      created += 1;
      return { ...t, dispose: () => { disposed += 1; } };
    };

    const depthformer: SessionLike = {
      inputNames: [],
      outputNames: [],
      run: async () => {
        const logits = new Float32Array(2049);
        logits[7] = 100;
        return {
          logits: track(tensor('float32', logits, [1, 2049])),
          depth_slices: track(
            tensor('float32', new Float32Array(NUM_CODEBOOKS * 1024), [1, NUM_CODEBOOKS, 1024]),
          ),
          new_keys: track(tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32])),
          new_values: track(tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32])),
        };
      },
    };

    await generateAudioFrame(depthformer, new Float32Array(HIDDEN_SIZE), factory, {
      audioTemperature: 0,
    });

    // Four tensors per codebook step, all but the last frame's cache released
    // inside the loop and that released at the end.
    expect(created).toBe(NUM_CODEBOOKS * 4);
    expect(disposed).toBe(created);
  });

  it('survives a session whose tensors cannot be disposed', async () => {
    // A plain object from a test double, or a CPU tensor, has no dispose().
    const depthformer: SessionLike = {
      inputNames: [],
      outputNames: [],
      run: async () => {
        const logits = new Float32Array(2049);
        logits[3] = 100;
        return {
          logits: tensor('float32', logits, [1, 2049]),
          depth_slices: tensor('float32', new Float32Array(NUM_CODEBOOKS * 1024), [1, NUM_CODEBOOKS, 1024]),
          new_keys: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
          new_values: tensor('float32', new Float32Array(0), [6, 1, 8, 0, 32]),
        };
      },
    };

    const codes = await generateAudioFrame(depthformer, new Float32Array(HIDDEN_SIZE), factory, {
      audioTemperature: 0,
    });
    expect(codes).toHaveLength(NUM_CODEBOOKS);
  });
});

