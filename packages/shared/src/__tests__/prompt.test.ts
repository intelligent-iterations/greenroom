import { describe, expect, it } from 'vitest';
import { compileInterviewerPrompt, selectFocusCompetencies } from '../prompt.js';
import type { RetrievedPassage } from '../retrieval.js';
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

/**
 * The compiled output as it stood before retrieval existed.
 *
 * Retrieval is an additive change to a versioned pure function that a CI gate
 * baselines against, so the claim "a call with no passages is byte-identical to
 * before" has to be a test rather than an assurance. These strings were
 * captured at PROMPT_VERSION 2026-09-05.5 and must not be regenerated from the
 * implementation — that would make the test agree with whatever the code does.
 */
describe('the no-passages path is unchanged', () => {
  it('compiles the full prompt exactly as it did before retrieval', () => {
    const compiled = compileInterviewerPrompt({ scenario, learner });
    expect(compiled.system).toMatchSnapshot();
  });

  it('compiles the compact prompt exactly as it did before retrieval', () => {
    const compiled = compileInterviewerPrompt({ scenario, learner, style: 'compact' });
    expect(compiled.system).toMatchSnapshot();
  });
});

function passage(text: string, chunkIndex = 0): RetrievedPassage {
  return { sourceId: 'doc:cv-1', chunkIndex, text, score: 1 };
}

describe('grounding in the full prompt', () => {
  // Never asserted before, despite contextNotes existing since the first commit.
  it('renders what the interviewer knows when the scenario says so', () => {
    const { system } = compileInterviewerPrompt({ scenario, learner });
    expect(system).toContain('# What you know');
    for (const note of scenario.contextNotes) expect(system).toContain(note);
  });

  it('renders retrieved passages in place of the scenario notes', () => {
    const { system } = compileInterviewerPrompt({
      scenario,
      learner,
      passages: [passage('Led the Kafka migration that halved checkout latency.')],
    });
    expect(system).toContain('Led the Kafka migration that halved checkout latency.');
    // Not merged: the retriever already searched the notes, so showing both
    // would print the chosen ones twice.
    for (const note of scenario.contextNotes) expect(system).not.toContain(note);
  });

  it('keeps the rules at the end, where the prompt is weighted hardest', () => {
    const { system } = compileInterviewerPrompt({
      scenario,
      learner,
      passages: [passage('Owned the on-call rotation.')],
    });
    expect(system.lastIndexOf('# Rules')).toBeGreaterThan(system.lastIndexOf('# What you know'));
  });
});

describe('grounding in the compact prompt', () => {
  const compact = (passages?: RetrievedPassage[]) =>
    compileInterviewerPrompt({ scenario, learner, style: 'compact', ...(passages ? { passages } : {}) })
      .system;

  it('carries at most one passage, however many it is given', () => {
    const system = compact([passage('First fact about Kafka.'), passage('Second fact about on-call.', 1)]);
    expect(system).toContain('First fact about Kafka.');
    expect(system).not.toContain('Second fact about on-call.');
  });

  it('truncates a long passage at a word boundary and adds no ellipsis', () => {
    const system = compact([passage('Kafka migration detail. '.repeat(20))]);
    const line = system.split('\n').find((l) => l.startsWith('One thing you know:'))!;
    const carried = line.slice('One thing you know: '.length);

    expect(carried.length).toBeLessThanOrEqual(140);
    // An ellipsis is a token the synthesiser may read aloud.
    expect(carried).not.toContain('…');
    expect(carried).not.toMatch(/\.\.\.$/);
    // Word boundary: the truncated text is a prefix of the original up to a
    // whole word, never a severed one.
    expect('Kafka migration detail. '.repeat(20)).toContain(carried);
    expect(carried).not.toMatch(/\s$/);
  });

  // Ordering here is measured, not stylistic: an earlier build with the output
  // constraint second of seven lines had 7 of 15 turns ask nothing at all.
  it('leaves the output constraint and the topic as the last two lines', () => {
    const lines = compact([passage('Owned the billing rewrite.')]).split('\n');
    expect(lines.at(-2)).toContain('ONE short question');
    expect(lines.at(-1)).toMatch(/^Ask about: /);
  });

  it('puts the grounding line before those two, not after them', () => {
    const lines = compact([passage('Owned the billing rewrite.')]).split('\n');
    expect(lines.findIndex((l) => l.startsWith('One thing you know:'))).toBe(lines.length - 3);
  });

  it('says nothing about grounding when there is none', () => {
    expect(compact()).not.toContain('One thing you know');
  });
});
