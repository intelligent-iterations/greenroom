import { describe, expect, it } from 'vitest';
import { compileInterviewerPrompt, selectFocusCompetencies } from '../prompt.js';
import { learner, scenario } from './fixtures.js';

describe('selectFocusCompetencies', () => {
  it('picks the weakest observed competencies', () => {
    expect(selectFocusCompetencies(scenario, learner)).toEqual([
      'concision',
      'quantified_impact',
    ]);
  });

  it('ranks an unobserved competency ahead of a merely weak one', () => {
    const sparse = { ...learner, mastery: learner.mastery.filter((m) => m.competency !== 'technical_depth') };
    // technical_depth is the strongest scored skill, but with it removed from
    // the estimates it becomes unobserved and outranks the weak-but-known ones.
    expect(selectFocusCompetencies(scenario, sparse, 1)).toEqual(['technical_depth']);
  });

  it('treats a low-observation estimate as unproven', () => {
    const thin = {
      ...learner,
      mastery: [{ competency: 'technical_depth' as const, score: 0.95, observations: 1, updatedAt: 0 }],
    };
    // 0.95 but only one observation, so it still ranks ahead of nothing proven.
    expect(selectFocusCompetencies(scenario, thin, 3)).toContain('technical_depth');
  });

  it('is stable across repeated calls', () => {
    const a = selectFocusCompetencies(scenario, learner);
    const b = selectFocusCompetencies(scenario, learner);
    expect(a).toEqual(b);
  });
});

describe('compileInterviewerPrompt', () => {
  it('is deterministic', () => {
    const a = compileInterviewerPrompt({ scenario, learner });
    const b = compileInterviewerPrompt({ scenario, learner });
    expect(a.system).toBe(b.system);
  });

  it('separates language level from difficulty', () => {
    const { system } = compileInterviewerPrompt({ scenario, learner });
    expect(system).toContain('CEFR B2');
    expect(system).toContain('does NOT lower the difficulty');
    expect(system).toContain('mid bar');
  });

  it('includes every required question', () => {
    const { system } = compileInterviewerPrompt({ scenario, learner });
    for (const q of scenario.requiredQuestions) expect(system).toContain(q);
  });

  it('forbids answer leakage and mid-session feedback', () => {
    const { system } = compileInterviewerPrompt({ scenario, learner });
    expect(system).toContain('Never answer your own question');
    expect(system).toContain('Never score, rate, grade');
  });

  it('re-raises a recurring error but never a one-off', () => {
    const withErrors = {
      ...learner,
      recentErrors: [
        { competency: 'concision' as const, note: 'rambles past two minutes', occurrences: 3, lastSeenAt: 2 },
        { competency: 'technical_depth' as const, note: 'one-off stumble', occurrences: 1, lastSeenAt: 3 },
      ],
    };
    const { system, reraisedError } = compileInterviewerPrompt({ scenario, learner: withErrors });
    expect(reraisedError).toBe('rambles past two minutes');
    expect(system).not.toContain('one-off stumble');
    expect(system).toContain('Do not mention their history');
  });

  it('emits French instructions for a French scenario', () => {
    const fr = { ...scenario, language: 'fr' as const };
    const { system } = compileInterviewerPrompt({ scenario: fr, learner });
    expect(system).toContain('Speak French');
  });
});
