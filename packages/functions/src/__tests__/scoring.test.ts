import type {
  LearnerState,
} from '@greenroom/shared/interview';
import { describe, expect, it } from 'vitest';
import { extractJson, foldScores, type AnswerScores } from '../scoring.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const learner: LearnerState = {
  userId: 'u1',
  cefr: 'B2',
  seniority: 'mid',
  language: 'en',
  targetRole: 'Backend Engineer',
  mastery: [{ competency: 'concision', score: 0.4, observations: 4, updatedAt: NOW - DAY }],
  recentErrors: [],
  sessionsCompleted: 3,
  updatedAt: NOW - DAY,
  documents: [],
};

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"scores":[]}')).toEqual({ scores: [] });
  });

  it('recovers JSON from a markdown fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in prose', () => {
    expect(extractJson('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('returns undefined for unparseable text', () => {
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{ broken')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
  });
});

describe('foldScores', () => {
  const scores: AnswerScores = [{ competency: 'concision', score: 0.9, note: '' }];

  it('moves an existing estimate toward the new observation', () => {
    const next = foldScores(learner, scores, NOW);
    const concision = next.mastery.find((m) => m.competency === 'concision')!;
    expect(concision.score).toBeGreaterThan(0.4);
    expect(concision.score).toBeLessThan(0.9);
    expect(concision.observations).toBe(5);
  });

  it('creates an estimate for a competency never seen before', () => {
    const next = foldScores(learner, [{ competency: 'technical_depth', score: 0.7, note: '' }], NOW);
    const added = next.mastery.find((m) => m.competency === 'technical_depth')!;
    expect(added).toEqual({
      competency: 'technical_depth',
      score: 0.7,
      observations: 1,
      updatedAt: NOW,
    });
  });

  it('increments the session count exactly once', () => {
    expect(foldScores(learner, scores, NOW).sessionsCompleted).toBe(4);
  });

  it('leaves untouched competencies alone', () => {
    const next = foldScores(learner, [{ competency: 'technical_depth', score: 0.1, note: '' }], NOW);
    expect(next.mastery.find((m) => m.competency === 'concision')?.score).toBe(0.4);
  });
});

describe('foldScores error tracking', () => {
  it('records a weak score that came with a usable note', () => {
    const next = foldScores(
      learner,
      [{ competency: 'concision', score: 0.2, note: 'answers run past three minutes' }],
      NOW,
    );
    expect(next.recentErrors).toEqual([
      {
        competency: 'concision',
        note: 'answers run past three minutes',
        occurrences: 1,
        lastSeenAt: NOW,
      },
    ]);
  });

  it('ignores a weak score with no note, and a good score with one', () => {
    expect(foldScores(learner, [{ competency: 'concision', score: 0.2, note: '' }], NOW).recentErrors)
      .toEqual([]);
    expect(
      foldScores(learner, [{ competency: 'concision', score: 0.9, note: 'still rambles' }], NOW)
        .recentErrors,
    ).toEqual([]);
  });

  it('counts a repeat of the same weakness rather than duplicating it', () => {
    const withError: LearnerState = {
      ...learner,
      recentErrors: [
        { competency: 'concision', note: 'old wording', occurrences: 1, lastSeenAt: NOW - DAY },
      ],
    };
    const next = foldScores(
      withError,
      [{ competency: 'concision', score: 0.2, note: 'new wording' }],
      NOW,
    );
    expect(next.recentErrors).toHaveLength(1);
    expect(next.recentErrors[0]).toMatchObject({ occurrences: 2, note: 'new wording' });
  });

  it('ages out an error nobody has seen for two months', () => {
    const stale: LearnerState = {
      ...learner,
      recentErrors: [
        { competency: 'technical_depth', note: 'stale', occurrences: 5, lastSeenAt: NOW - 61 * DAY },
      ],
    };
    expect(foldScores(stale, [], NOW).recentErrors).toEqual([]);
  });

  it('keeps at most ten errors, newest first', () => {
    const many: LearnerState = {
      ...learner,
      recentErrors: Array.from({ length: 12 }, (_, i) => ({
        competency: 'concision' as const,
        note: `note ${i}`,
        occurrences: 1,
        lastSeenAt: NOW - i * 1000,
      })),
    };
    const next = foldScores(many, [], NOW);
    expect(next.recentErrors).toHaveLength(10);
    expect(next.recentErrors[0]?.note).toBe('note 0');
  });
});
