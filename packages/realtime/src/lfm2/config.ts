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

/** Text vocabulary. From embed_tokens.json. */
export const TEXT_VOCAB = 65536;

/**
 * Switches the decoder from emitting text to emitting audio frames.
 *
 * The README's reference loop compares the sampled token against 128 to enter
 * audio mode.
 */
export const AUDIO_START_TOKEN = 128;

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
 * Only the 1.5B is listed as verified-available, because it is the one whose
 * files were checked byte by byte. The card is explicit that WebGPU wants the
 * q4 decoder and q4 vocoder and that q8 is not supported there, so q8 is absent
 * rather than offered and broken.
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
  {
    id: 'lfm2.5-audio-1.5b-fp16',
    label: 'LFM2.5 Audio 1.5B (FP16)',
    repo: 'LiquidAI/LFM2.5-Audio-1.5B-ONNX',
    suffix: '_fp16',
    downloadMb: 3900,
    vramMb: 4600,
    notes: 'Higher quality, roughly twice the download. Wants a large GPU.',
  },
];
