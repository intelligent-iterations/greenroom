import { describe, expect, it } from 'vitest';
import { splitSpeakableChunks } from '../pipeline.js';

describe('splitSpeakableChunks', () => {
  it('emits complete sentences and keeps the remainder', () => {
    const [chunks, rest] = splitSpeakableChunks(
      'Tell me about that migration. What did you give up? And the',
    );
    expect(chunks).toEqual(['Tell me about that migration.', 'What did you give up?']);
    expect(rest).toBe('And the');
  });

  it('holds a partial sentence until it terminates', () => {
    expect(splitSpeakableChunks('Walk me through the')).toEqual([[], 'Walk me through the']);
  });

  it('does not split inside a decimal or abbreviation', () => {
    const [chunks] = splitSpeakableChunks('It ran at 3.5 seconds per request. Why?');
    expect(chunks).toEqual(['It ran at 3.5 seconds per request.']);
  });

  it('holds very short fragments so they merge with what follows', () => {
    const [chunks, rest] = splitSpeakableChunks('Right. So what changed after the rollout? ');
    expect(chunks).toEqual(['Right. So what changed after the rollout?']);
    expect(rest).toBe('');
  });

  it('handles an empty buffer', () => {
    expect(splitSpeakableChunks('')).toEqual([[], '']);
  });
});
