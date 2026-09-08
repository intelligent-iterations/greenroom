import { describe, expect, it } from 'vitest';
import { createLocalCache, findLocalFile } from '../local-models.js';

/**
 * The security question this answers, from the release checklist: can a
 * malicious request reach a file the user did not choose?
 *
 * It cannot, and the reason is structural rather than defensive. The app never
 * touches a filesystem. `files` is the array the browser's own directory picker
 * handed over, and every candidate is drawn from it, so the worst a crafted
 * path achieves is matching a file the user already offered — or nothing.
 * The picker is the sandbox; this file just has to not undo that.
 */
function fileOf(name: string, body = 'x'): File {
  return new File([body], name);
}

const chosen = new Map<string, File>([
  ['my-model/config.json', fileOf('config.json')],
  ['my-model/onnx/model_q4.onnx', fileOf('model_q4.onnx')],
]);

describe('findLocalFile', () => {
  it('serves a file the user chose', () => {
    expect(findLocalFile(chosen, 'https://huggingface.co/repo/resolve/main/config.json')).toBe(
      chosen.get('my-model/config.json'),
    );
  });

  it('returns nothing for a file that was never offered', () => {
    expect(findLocalFile(chosen, 'https://huggingface.co/repo/resolve/main/secrets.env')).toBeUndefined();
  });

  it('cannot be walked out of the selection with a traversal path', () => {
    for (const attack of [
      '../../../../etc/passwd',
      'https://x.invalid/../../../../etc/passwd',
      '/etc/shadow',
      'file:///etc/passwd',
      '..%2f..%2fetc%2fpasswd',
    ]) {
      const found = findLocalFile(chosen, attack);
      // Whatever it returns, it can only ever be one of the files handed over.
      expect(found === undefined || [...chosen.values()].includes(found)).toBe(true);
    }
  });

  it('only ever returns a file from the given list', () => {
    const found = findLocalFile(chosen, 'anything-at-all');
    expect(found === undefined || [...chosen.values()].includes(found)).toBe(true);
  });
});

describe('createLocalCache', () => {
  it('serves a chosen file and misses on anything else', async () => {
    const cache = createLocalCache(chosen);
    expect(await cache.match('.../config.json')).toBeDefined();
    expect(await cache.match('.../not-offered.bin')).toBeUndefined();
  });

  // These are the user's files, lent for a session. A cache that wrote back
  // would be modifying a folder we were only shown.
  it('never writes back', async () => {
    const cache = createLocalCache(chosen);
    await expect(cache.put()).resolves.toBeUndefined();
  });
});
