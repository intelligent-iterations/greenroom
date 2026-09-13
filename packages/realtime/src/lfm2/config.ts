/**
 * LFM2.5-Audio: an end-to-end speech-to-speech model that runs in a browser.
 *
 * Every constant here is taken from the model's own published files —
 * `config.json`, `onnx/mel_config.json`, `onnx/embed_tokens.json`,
 * `onnx/audio_embedding.json` and the ONNX graph signatures — not from a blog
 * post or from memory. Where a value is load-bearing the comment says which
 * file it came from, because a silently wrong hop length or codebook stride
 * produces audio that is merely *wrong* rather than absent, and that is very
 * expensive to debug from the sound alone.
 *
 * This is the piece that makes in-browser duplex possible at all. A cascade
 * (recognise, then think, then speak) has three models and three latencies; this
 * has one model that takes speech and emits speech, and it is small enough to
 * run on a laptop GPU.
 */

/** Hidden width of the LFM2 backbone. From config.json `lfm.block_dim`. */
export const HIDDEN_SIZE = 2048;

/** Residual audio codebooks per frame. From config.json `codebooks`. */
export const NUM_CODEBOOKS = 8;

/**
 * Tokens per codebook: 0–2047 are audio, 2048 means end-of-audio.
 * From audio_embedding.json `codebook_vocab`.
 */
export const CODEBOOK_VOCAB = 2049;
export const END_OF_AUDIO = 2048;
/** The largest code the detokenizer can turn into sound. */
export const MAX_AUDIO_CODE = 2047;

/** Text vocabulary. From embed_tokens.json. */
export const TEXT_VOCAB = 65536;

/**
 * Control tokens, read from the model's own tokenizer_config.json.
 *
 * Verified against `added_tokens_decoder`, not inferred:
 *   7 = <|im_end|>, 128 = <|audio_start|>, 129 = <|text_start|>,
 *   130 = <|text_end|>, 2 = <|endoftext|>.
 *
 * IM_END is the one whose absence was expensive. Without a turn-ending token
 * the generation loop had no stop condition at all except the step limit, so
 * every reply ran to hundreds of tokens — a good opening sentence followed by
 * whatever the model free-associated into, and it never reached the audio it
 * was asked for. The README's WebGPU snippet omits it; the reference
 * implementation in Liquid4All/onnx-export breaks on it.
 */
export const AUDIO_START_TOKEN = 128;
export const TEXT_START_TOKEN = 129;
export const TEXT_END_TOKEN = 130;
export const IM_END_TOKEN = 7;
export const END_OF_TEXT_TOKEN = 2;

/**
 * The system instruction that actually produces speech.
 *
 * Taken verbatim from the reference implementation's interleaved mode, and it
 * is not interchangeable with a paraphrase: an invented instruction like
 * "Respond conversationally with audio" leaves the model answering in text
 * forever, which is indistinguishable from the audio pipeline being broken.
 */
export const INTERLEAVED_SYSTEM_PROMPT = 'Respond with interleaved text and audio.';

/** The reference's TTS instruction, and its default voice. */
export const TTS_SYSTEM_PROMPT = 'Perform TTS. Use the UK female voice.';

/**
 * Sampling, from the reference implementation's interleaved mode.
 *
 * text_temperature=1.0, audio_temperature=1.0, audio_top_k=4.
 */
export const REFERENCE_TEXT_TEMPERATURE = 1.0;
export const REFERENCE_AUDIO_TEMPERATURE = 1.0;
export const REFERENCE_AUDIO_TOP_K = 4;

/** Input side. From onnx/mel_config.json. */
export const INPUT_SAMPLE_RATE = 16_000;
export const MEL_CONFIG = {
  nFft: 512,
  winLength: 400,
  hopLength: 160,
  nMels: 128,
  fMin: 0,
  fMax: 8000,
  preemph: 0.97,
  logZeroGuard: 5.960464477539063e-8,
} as const;

/**
 * Output side. From the model card's "Audio Processing Details".
 *
 * One audio frame is 80ms: 320 hop at 24kHz is 13.3ms, and the detokenizer
 * upsamples 6x, giving 6 * 13.3ms. That figure is what lets a caller schedule
 * playback without waiting for the whole utterance.
 */
export const OUTPUT_SAMPLE_RATE = 24_000;
export const ISTFT_CONFIG = { nFft: 1280, hopLength: 320 } as const;
export const DETOKENIZER_UPSAMPLE = 6;
export const FRAME_DURATION_MS = 80;

/**
 * Per-layer cache shape. Read off the decoder graph rather than assumed: LFM2 is
 * a *hybrid*, so most blocks carry a small convolution state and only some carry
 * attention keys and values. Getting this wrong does not fail loudly — it
 * degrades the voice.
 */
export const CONV_CACHE_WIDTH = 3;
export const ATTENTION_HEADS = 8;
export const HEAD_DIM = 64;

/** Depth transformer, from the vocoder_depthformer graph. */
export const DEPTHFORMER_LAYERS = 6;
export const DEPTHFORMER_HEADS = 8;
export const DEPTHFORMER_HEAD_DIM = 32;
export const DEPTH_SLICE_WIDTH = 1024;

export type Precision = 'q4' | 'q8' | 'fp16' | 'fp32';

export interface LfmModelSpec {
  id: string;
  label: string;
  /** Hugging Face repository. */
  repo: string;
  /** Suffix on the ONNX files, e.g. `_q4`. Empty for fp32. */
  suffix: string;
  /** Total download, MB, summed from the published file sizes. */
  downloadMb: number;
  /** Rough peak GPU memory. Weights plus room for activations and cache. */
  vramMb: number;
  notes: string;
}

/**
 * What can actually be run.
 *
 * One entry, because one entry works. An FP16 build was listed here and could
 * never have loaded: `manifestFor` knows only `_q4`, so its survey found no
 * files, reported "Every file is here. Nothing to download." over an empty
 * manifest, and then asked for filenames that do not exist. Its decoder also
 * splits weights across `decoder_fp16.onnx_data` *and* `..._data_1`, which the
 * single-external-file assumption here cannot express at all.
 *
 * The card is explicit that WebGPU wants the q4 decoder and q4 vocoder and that
 * q8 is not supported there, so q8 is absent rather than offered and broken.
 *
 * Larger LFM2.5-Audio checkpoints slot in here unchanged when their ONNX
 * exports appear — same graph names, same protocol, different weights. The
 * shape of this list is the extension point; adding an entry whose files have
 * not been checked would be the same mistake as a router offering a model
 * nothing can serve.
 */
export const LFM_MODELS: LfmModelSpec[] = [
  {
    id: 'lfm2.5-audio-1.5b-q4',
    label: 'LFM2.5 Audio 1.5B (Q4)',
    repo: 'LiquidAI/LFM2.5-Audio-1.5B-ONNX',
    suffix: '_q4',
    // decoder 1161 + encoder 133 + depthformer 178 + detokenizer 54 +
    // audio_embedding 128 + embed_tokens 512.
    downloadMb: 2166,
    vramMb: 2600,
    notes: 'End-to-end speech in, speech out. The recommended WebGPU build.',
  },
];
