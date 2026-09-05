import { describe, expect, it } from 'vitest';
import { DEFAULT_GATES, evaluateGates, toBaseline, type Baseline } from '../gate.ts';
import { RUBRIC } from '../deps.ts';
import type { CaseResult, EvalReport } from '../types.ts';

function report(overrides: Partial<EvalReport['summary']> = {}, results: CaseResult[] = []): EvalReport {
  return {
    startedAt: '2026-09-05T00:00:00.000Z',
    promptVersion: '1.0.0',
    modelId: 'replay',
    judgeId: 'gemini',
    results,
    summary: {
      cases: 10,
      scored: 10,
      errors: 0,
      composite: 0.85,
      byDimension: Object.fromEntries(RUBRIC.map((d) => [d.id, 4.5])),
      criticalFailures: 0,
      checkFailures: 0,
      ...overrides,
    },
  };
}

const baseline: Baseline = {
  promptVersion: '1.0.0',
  modelId: 'replay',
  composite: 0.84,
  byDimension: {},
  recordedAt: '2026-09-01T00:00:00.000Z',
};

describe('evaluateGates', () => {
  it('passes a healthy run', () => {
    expect(evaluateGates(report(), DEFAULT_GATES, baseline).passed).toBe(true);
  });

  it('fails on a composite below the floor', () => {
    const result = evaluateGates(report({ composite: 0.6 }), DEFAULT_GATES);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/below the floor/);
  });

  it('fails on a single weak dimension despite a good average', () => {
    const byDimension = Object.fromEntries(RUBRIC.map((d) => [d.id, 4.8]));
    byDimension['safety'] = 2.9;
    const result = evaluateGates(report({ byDimension }), DEFAULT_GATES);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('safety'))).toBe(true);
  });

  it('fails on any critical failure regardless of the average', () => {
    const results = [
      {
        case: { id: 'c1', scenario: 's', probes: 'p', learner: {}, transcript: [], tags: [] },
        turn: 'x',
        checks: [],
        scores: [],
        composite: 1,
        criticalFailures: ['answer_leakage'],
      },
    ] satisfies CaseResult[];
    const result = evaluateGates(report({ composite: 0.99 }, results), DEFAULT_GATES);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/critical failure on answer_leakage/);
  });

  it('fails on a regression beyond the tolerance', () => {
    const result = evaluateGates(report({ composite: 0.79 }), DEFAULT_GATES, baseline);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('regressed'))).toBe(true);
  });

  it('tolerates a small dip within the allowance', () => {
    const result = evaluateGates(report({ composite: 0.82 }), DEFAULT_GATES, baseline);
    expect(result.passed).toBe(true);
    expect(result.notes.some((n) => n.includes('against baseline'))).toBe(true);
  });

  it('notes, rather than fails, a comparison across a prompt version change', () => {
    const result = evaluateGates(
      report(),
      DEFAULT_GATES,
      { ...baseline, promptVersion: '0.9.0' },
    );
    expect(result.passed).toBe(true);
    expect(result.notes.some((n) => n.includes('Prompt version changed'))).toBe(true);
  });

  it('fails when cases could not run at all', () => {
    const result = evaluateGates(report({ errors: 2 }), DEFAULT_GATES);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/failed to run/);
  });

  it('does not claim to have evaluated thresholds it skipped', () => {
    const result = evaluateGates(report({ scored: 0, composite: 0 }), DEFAULT_GATES);
    expect(result.passed).toBe(true);
    expect(result.notes.some((n) => n.includes('deterministic checks only'))).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('still fails a deterministic-only run that hit a critical check', () => {
    const results = [
      {
        case: { id: 'c1', scenario: 's', probes: 'p', learner: {}, transcript: [], tags: [] },
        turn: 'x',
        checks: [],
        scores: [],
        composite: 0,
        criticalFailures: ['check:speakable'],
      },
    ] satisfies CaseResult[];
    expect(evaluateGates(report({ scored: 0 }, results), DEFAULT_GATES).passed).toBe(false);
  });
});

describe('toBaseline', () => {
  it('captures what a later run is compared against', () => {
    const b = toBaseline(report());
    expect(b).toMatchObject({ promptVersion: '1.0.0', modelId: 'replay', composite: 0.85 });
    expect(b.recordedAt).toMatch(/^\d{4}-/);
  });
});
