import { describe, expect, it } from 'vitest';
import { ThinkingStripper, splitSpeakableChunks } from '../pipeline.js';

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

describe('splitSpeakableChunks clause fallback', () => {
  it('breaks at a clause only when no sentence is available yet', () => {
    const [chunks, rest] = splitSpeakableChunks(
      'Thanks for making the time, let us start with',
      { allowClauseBreak: true },
    );
    expect(chunks).toEqual(['Thanks for making the time,']);
    expect(rest).toBe('let us start with');
  });

  it('prefers a complete sentence over a clause break', () => {
    const [chunks] = splitSpeakableChunks(
      'Walk me through the migration. Then, tell me what broke, and why.',
      { allowClauseBreak: true },
    );
    expect(chunks).toEqual(['Walk me through the migration.']);
  });

  it('holds a clause too short to sound deliberate', () => {
    expect(splitSpeakableChunks('So, tell me', { allowClauseBreak: true })).toEqual([
      [],
      'So, tell me',
    ]);
  });

  it('never breaks at a clause once audio has started', () => {
    expect(splitSpeakableChunks('Thanks for making the time, let us start with')).toEqual([
      [],
      'Thanks for making the time, let us start with',
    ]);
  });

  it('emits at most one clause chunk so the rest can form real sentences', () => {
    const [chunks] = splitSpeakableChunks(
      'First of all, thanks for coming, and welcome, please sit',
      { allowClauseBreak: true },
    );
    expect(chunks).toHaveLength(1);
  });
});

describe('ThinkingStripper', () => {
  const strip = (deltas: string[]) => {
    const s = new ThinkingStripper();
    return deltas.map((d) => s.push(d)).join('') + s.flush();
  };

  it('passes ordinary text through untouched', () => {
    expect(strip(['Walk me ', 'through the migration.'])).toBe('Walk me through the migration.');
  });

  it('removes a complete reasoning block', () => {
    expect(strip(['<think>they were vague</think>What did you measure?'])).toBe(
      'What did you measure?',
    );
  });

  it('removes a block whose tags straddle delta boundaries', () => {
    // The case a stateless regex gets wrong, and the one that actually happens.
    expect(strip(['<thi', 'nk>hmm', ' more', '</thi', 'nk>What changed?'])).toBe('What changed?');
  });

  it('never emits a partial opening tag as speech', () => {
    const s = new ThinkingStripper();
    expect(s.push('Ready. <thi')).toBe('Ready. ');
    expect(s.push('nk>secret</think>Go on.')).toBe('Go on.');
  });

  it('discards everything after an unterminated block', () => {
    // Speaking an unfinished deliberation aloud is the failure being prevented.
    const s = new ThinkingStripper();
    expect(s.push('<think>still reasoning and never closing')).toBe('');
    expect(s.flush()).toBe('');
  });

  it('handles the empty prepended block that disabling thinking produces', () => {
    expect(strip(['<think>\n\n</think>\n\nTell me about that.'])).toBe('\n\nTell me about that.');
  });

  it('handles several blocks in one stream', () => {
    expect(strip(['<think>a</think>One.<think>b</think> Two.'])).toBe('One. Two.');
  });

  it('reports whether it is inside a block', () => {
    const s = new ThinkingStripper();
    s.push('<think>mid');
    expect(s.insideReasoningBlock).toBe(true);
    s.push('</think>done');
    expect(s.insideReasoningBlock).toBe(false);
  });

  it('flushes buffered text held back as a possible tag', () => {
    const s = new ThinkingStripper();
    expect(s.push('All done <')).toBe('All done ');
    expect(s.flush()).toBe('<');
  });
});
