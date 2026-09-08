import { describe, expect, it } from 'vitest';
import {
  COACHING_RUBRIC,
  LANGUAGE_LEARNING_RUBRIC,
  RUBRIC,
  SPOKEN_RUBRIC,
  applicableRubric,
  buildJudgePrompt,
  compositeScore,
  criticalFailures,
  type DimensionScore,
} from '../rubric.js';

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
  it('includes the interviewer prompt, the turn, and every applicable dimension', () => {
    const p = buildJudgePrompt({
      agentSystemPrompt: 'SYSTEM_MARKER',
      transcript: 'Interviewer: hi',
      turnUnderTest: 'TURN_MARKER',
      passages: ['The team runs Postgres.'],
    });
    expect(p).toContain('SYSTEM_MARKER');
    expect(p).toContain('TURN_MARKER');
    for (const d of RUBRIC) expect(p).toContain(d.id);
  });

  // Scoring a turn on its use of context it was never given produces a number
  // that means nothing — and then drags the dimension mean under its gate
  // floor on every case that has nothing to ground against.
  it('drops the grounding dimension when the interviewer was given no context', () => {
    const p = buildJudgePrompt({
      agentSystemPrompt: 'x',
      transcript: '',
      turnUnderTest: 't',
    });
    expect(p).not.toContain('grounding');
    for (const d of RUBRIC.filter((d) => d.id !== 'grounding')) expect(p).toContain(d.id);
  });

  it('shows the judge the context the interviewer had', () => {
    const p = buildJudgePrompt({
      agentSystemPrompt: 'x',
      transcript: '',
      turnUnderTest: 't',
      passages: ['They owned the payments service.'],
    });
    expect(p).toContain('They owned the payments service.');
    expect(p).toContain('grounding');
  });

  it('labels the opening turn when there is no transcript', () => {
    expect(buildJudgePrompt({ agentSystemPrompt: 'x', transcript: '', turnUnderTest: 't' })).toContain(
      'this is the opening turn',
    );
  });
});

describe('applicableRubric', () => {
  it('scores grounding only when the interviewer was given something to ground in', () => {
    expect(applicableRubric([]).map((d) => d.id)).not.toContain('grounding');
    expect(applicableRubric(['a fact']).map((d) => d.id)).toContain('grounding');
  });

  it('leaves every other dimension alone either way', () => {
    expect(applicableRubric([])).toHaveLength(RUBRIC.length - 1);
    expect(applicableRubric(['a fact'])).toHaveLength(RUBRIC.length);
  });

  // compositeScore normalises over the dimensions actually present, so a
  // grounded and an ungrounded case stay comparable on the same 0..1 scale.
  it('keeps composites comparable across both shapes', () => {
    const perfectOf = (ids: string[]): DimensionScore[] =>
      ids.map((id) => ({ dimension: id as DimensionScore['dimension'], score: 5, evidence: 'q' }));
    expect(compositeScore(perfectOf(applicableRubric([]).map((d) => d.id)))).toBeCloseTo(1);
    expect(compositeScore(perfectOf(applicableRubric(['f']).map((d) => d.id)))).toBeCloseTo(1);
  });
});

describe('composable rubric packs', () => {
  it('covers every dimension exactly once between the packs', () => {
    const composed = [...SPOKEN_RUBRIC, ...COACHING_RUBRIC, ...LANGUAGE_LEARNING_RUBRIC];
    expect(composed.map((d) => d.id).sort()).toEqual(RUBRIC.map((d) => d.id).sort());
    expect(new Set(composed.map((d) => d.id)).size).toBe(composed.length);
  });

  // The spoken pack has to stand alone: it is what someone evaluating a support
  // bot or a booking assistant will use, and none of those are being coached.
  it('leaves the spoken pack free of coaching assumptions', () => {
    const ids = SPOKEN_RUBRIC.map((d) => d.id);
    expect(ids).not.toContain('answer_leakage');
    expect(ids).not.toContain('difficulty_calibration');
    expect(ids).not.toContain('coverage_progress');
  });

  it('keeps a critical dimension in the pack that needs it', () => {
    expect(SPOKEN_RUBRIC.find((d) => d.id === 'safety')?.critical).toBe(true);
    expect(COACHING_RUBRIC.find((d) => d.id === 'answer_leakage')?.critical).toBe(true);
  });

  it('scores a composed rubric on its own scale', () => {
    const perfectOf = (dims: typeof RUBRIC): DimensionScore[] =>
      dims.map((d) => ({ dimension: d.id, score: 5, evidence: 'q' }));
    expect(compositeScore(perfectOf(SPOKEN_RUBRIC))).toBeCloseTo(1);
    expect(compositeScore(perfectOf(RUBRIC))).toBeCloseTo(1);
  });

  it('narrows a composed rubric when there is nothing to ground in', () => {
    const narrowed = applicableRubric([], SPOKEN_RUBRIC).map((d) => d.id);
    expect(narrowed).not.toContain('grounding');
    expect(narrowed).toContain('role_fidelity');
  });

  it('builds a judge prompt for a composed rubric and no others', () => {
    const prompt = buildJudgePrompt({
      agentSystemPrompt: 'x',
      transcript: '',
      turnUnderTest: 't',
      rubric: SPOKEN_RUBRIC,
      passages: ['a fact'],
    });
    expect(prompt).toContain('role_fidelity');
    expect(prompt).not.toContain('difficulty_calibration');
  });
});
