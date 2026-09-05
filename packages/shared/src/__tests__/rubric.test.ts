import { describe, expect, it } from 'vitest';
import { RUBRIC, compositeScore, criticalFailures, buildJudgePrompt, type DimensionScore } from '../rubric.js';

const perfect: DimensionScore[] = RUBRIC.map((d) => ({
  dimension: d.id,
  score: 5,
  evidence: 'quote',
}));

describe('compositeScore', () => {
  it('maps an all-5 verdict to 1 and an all-1 verdict to 0', () => {
    expect(compositeScore(perfect)).toBe(1);
    expect(compositeScore(perfect.map((s) => ({ ...s, score: 1 })))).toBe(0);
  });

  it('weights critical dimensions more heavily', () => {
    const dropSafety = perfect.map((s) => (s.dimension === 'safety' ? { ...s, score: 1 } : s));
    const dropRole = perfect.map((s) => (s.dimension === 'role_fidelity' ? { ...s, score: 1 } : s));
    expect(compositeScore(dropSafety)).toBeLessThan(compositeScore(dropRole));
  });

  it('ignores dimensions the judge omitted rather than scoring them zero', () => {
    expect(compositeScore(perfect.slice(0, 2))).toBe(1);
  });

  it('returns 0 for an empty verdict', () => {
    expect(compositeScore([])).toBe(0);
  });
});

describe('criticalFailures', () => {
  it('flags a critical dimension at or below 2', () => {
    const leaked = perfect.map((s) => (s.dimension === 'answer_leakage' ? { ...s, score: 2 } : s));
    expect(criticalFailures(leaked).map((f) => f.dimension)).toEqual(['answer_leakage']);
  });

  it('ignores a non-critical dimension scoring 1', () => {
    const verbose = perfect.map((s) => (s.dimension === 'voice_form' ? { ...s, score: 1 } : s));
    expect(criticalFailures(verbose)).toEqual([]);
  });

  it('ignores a critical dimension scoring 3', () => {
    const ok = perfect.map((s) => (s.dimension === 'safety' ? { ...s, score: 3 } : s));
    expect(criticalFailures(ok)).toEqual([]);
  });
});

describe('buildJudgePrompt', () => {
  it('includes the interviewer prompt, the turn, and every dimension', () => {
    const p = buildJudgePrompt({
      interviewerSystemPrompt: 'SYSTEM_MARKER',
      transcript: 'Interviewer: hi',
      turnUnderTest: 'TURN_MARKER',
    });
    expect(p).toContain('SYSTEM_MARKER');
    expect(p).toContain('TURN_MARKER');
    for (const d of RUBRIC) expect(p).toContain(d.id);
  });

  it('labels the opening turn when there is no transcript', () => {
    expect(buildJudgePrompt({ interviewerSystemPrompt: 'x', transcript: '', turnUnderTest: 't' })).toContain(
      'this is the opening turn',
    );
  });
});
