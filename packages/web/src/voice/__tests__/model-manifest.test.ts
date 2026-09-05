import { describe, expect, it } from 'vitest';
import {
  MODEL_MANIFEST,
  expectedFiles,
  findStage,
  huggingFaceUrl,
  onnxFileName,
} from '../model-manifest.js';

/**
 * Static proof that the pipeline is configured to fetch files that exist.
 *
 * These tests are offline and deterministic: given a repo, module and dtype the
 * URL is fully determined, so the mapping can be proven here and the existence
 * of those exact URLs checked separately by `pnpm preflight`. Together they
 * replace "download a gigabyte and see what happens" with two fast checks.
 */
describe('onnxFileName', () => {
  it('maps full precision to the unsuffixed file', () => {
    expect(onnxFileName('model', 'fp32')).toBe('onnx/model.onnx');
    expect(onnxFileName('encoder_model', 'fp32')).toBe('onnx/encoder_model.onnx');
  });

  it('maps q8 to the "quantized" name rather than "_q8"', () => {
    // The naming these repositories actually use; guessing "_q8" 404s.
    expect(onnxFileName('decoder_model_merged', 'q8')).toBe(
      'onnx/decoder_model_merged_quantized.onnx',
    );
  });

  it.each([
    ['fp16', 'onnx/model_fp16.onnx'],
    ['q4', 'onnx/model_q4.onnx'],
    ['q4f16', 'onnx/model_q4f16.onnx'],
    ['int8', 'onnx/model_int8.onnx'],
    ['uint8', 'onnx/model_uint8.onnx'],
    ['bnb4', 'onnx/model_bnb4.onnx'],
  ])('maps %s correctly', (dtype, expected) => {
    expect(onnxFileName('model', dtype)).toBe(expected);
  });

  it('refuses an unknown dtype instead of inventing a filename', () => {
    expect(() => onnxFileName('model', 'q3')).toThrow(/Unknown dtype/);
  });
});

describe('manifest', () => {
  it('covers all four on-device stages', () => {
    expect(MODEL_MANIFEST.map((s) => s.stage).sort()).toEqual(['llm', 'stt', 'tts', 'vad']);
  });

  it('declares both devices for every stage', () => {
    for (const spec of MODEL_MANIFEST) {
      expect(Object.keys(spec.modules).sort()).toEqual(['wasm', 'webgpu']);
    }
  });

  it('keeps the Whisper encoder at full precision on both devices', () => {
    // The regression this guards: a single dtype string quantised the encoder,
    // which is what governs accuracy on accented speech.
    const stt = findStage('stt');
    expect(stt.modules.webgpu['encoder_model']).toBe('fp32');
    expect(stt.modules.wasm['encoder_model']).toBe('fp32');
  });

  it('resolves the Whisper file set per device', () => {
    const stt = findStage('stt');
    expect(expectedFiles(stt, 'webgpu')).toContain('onnx/encoder_model.onnx');
    expect(expectedFiles(stt, 'webgpu')).toContain('onnx/decoder_model_merged.onnx');
    expect(expectedFiles(stt, 'wasm')).toContain('onnx/decoder_model_merged_quantized.onnx');
  });

  it('does not expect a config.json for the VAD repository', () => {
    // Verified absent upstream; the loader is handed an inline config instead.
    const vad = findStage('vad');
    expect(vad.extraFiles).toEqual([]);
    expect(vad.inlineConfig).toEqual({ model_type: 'custom' });
  });

  it('requires a tokenizer wherever text is encoded', () => {
    for (const stage of ['llm', 'stt', 'tts'] as const) {
      expect(findStage(stage).extraFiles).toContain('tokenizer.json');
    }
  });

  it('builds resolvable Hugging Face URLs', () => {
    expect(huggingFaceUrl('onnx-community/whisper-base', 'onnx/encoder_model.onnx')).toBe(
      'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model.onnx',
    );
  });

  it('throws for a stage that does not exist', () => {
    expect(() => findStage('asr' as never)).toThrow(/No manifest entry/);
  });
});
