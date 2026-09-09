import { describe, expect, it } from 'vitest';
import { storagePathFor } from '../model-store.js';

/**
 * The path mapping is the part with teeth: it decides where bytes land inside
 * a folder the user handed over, so it has to be both predictable and unable
 * to climb out of that folder.
 */
describe('storagePathFor', () => {
  it('keeps the repository layout, so the folder stays legible to other tools', () => {
    expect(
      storagePathFor('https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model.onnx'),
    ).toEqual(['onnx-community', 'whisper-base', 'onnx', 'encoder_model.onnx']);
  });

  it('handles a file at the repository root', () => {
    expect(storagePathFor('https://huggingface.co/a/b/resolve/main/config.json')).toEqual([
      'a',
      'b',
      'config.json',
    ]);
  });

  it('copes with a URL that has no resolve segment', () => {
    expect(storagePathFor('https://example.invalid/a/b/model.onnx')).toEqual(['a', 'b', 'model.onnx']);
  });

  // The folder is lent, not surrendered. Nothing may be written above it.
  it('cannot be walked out of the chosen folder', () => {
    for (const url of [
      'https://huggingface.co/../../etc/passwd',
      'https://huggingface.co/a/../../../b/resolve/main/x.onnx',
      'https://huggingface.co/./././resolve/main/y.onnx',
    ]) {
      const path = storagePathFor(url);
      expect(path).not.toContain('..');
      expect(path).not.toContain('.');
      expect(path.every((p) => p.length > 0)).toBe(true);
    }
  });
});
