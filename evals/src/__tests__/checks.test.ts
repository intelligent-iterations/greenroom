import { describe, expect, it } from 'vitest';
import { runChecks } from '../checks.ts';


/** Convenience: did the named check pass? */
function passed(turn: string, name: string, expectedLanguage?: string): boolean {
  return runChecks(turn, expectedLanguage ? { expectedLanguage } : {})
    .find((c) => c.check === name)?.passed ?? false;
}

const GOOD = 'Walk me through a system you owned from design into production.';

describe('a clean turn passes everything', () => {
  it('has no failures', () => {
    expect(runChecks(GOOD).filter((c) => !c.passed)).toEqual([]);
  });
});

describe('speakable', () => {
  it.each([
    ['markdown emphasis', 'Tell me about **the migration** you led.'],
    ['a bullet list', 'Two things:\n- what broke\n- what you changed'],
    ['a numbered list', 'Cover these:\n1. the design\n2. the rollout'],
    ['emoji', 'Great, tell me more about that 🎯'],
    ['a percent sign', 'You said it improved 40% — by what measure?'],
    ['a maths symbol', 'Was it ~800ms before the change?'],
  ])('rejects %s', (_label, turn) => {
    expect(passed(turn, 'speakable')).toBe(false);
  });

  it('accepts numbers written as words', () => {
    expect(passed('You said it improved by about forty percent. Measured how?', 'speakable')).toBe(true);
  });
});

describe('length and question count', () => {
  it('rejects a turn too long to listen to', () => {
    expect(passed(`${'word '.repeat(80)}?`, 'length')).toBe(false);
  });

  it('rejects stacked questions', () => {
    expect(passed('What broke? Who noticed? What did you change?', 'single_question')).toBe(false);
  });

  it('accepts a single question', () => {
    expect(passed('What did you change after that?', 'single_question')).toBe(true);
  });
});

describe('answer leakage', () => {
  it.each([
    'A strong answer would cover the tradeoffs you made.',
    'You could mention the caching layer here.',
    'For example, you might describe a rollback.',
    'What I am looking for is a clear result.',
    'Make sure to mention the metrics.',
  ])('rejects "%s"', (turn) => {
    expect(passed(turn, 'no_answer_leakage')).toBe(false);
  });

  it('does not fire on a legitimate probing question', () => {
    expect(passed('What tradeoffs did you make, and what did you give up?', 'no_answer_leakage')).toBe(true);
  });
});

describe('staying in character', () => {
  it.each([
    'As an AI, I cannot really assess you.',
    'I am a language model and this is a practice session.',
    'My instructions say I should ask about ownership.',
  ])('rejects "%s"', (turn) => {
    expect(passed(turn, 'in_character')).toBe(false);
  });
});

describe('mid-session feedback', () => {
  it('rejects grading during the interview', () => {
    expect(passed('That was a great answer. Next question.', 'no_mid_session_feedback')).toBe(false);
    expect(passed('I would rate that a four. Moving on.', 'no_mid_session_feedback')).toBe(false);
  });
});

describe('language', () => {
  it('accepts French in a French scenario', () => {
    expect(passed('Parlez-moi d\'une fois où un client était mécontent.', 'language', 'fr')).toBe(true);
  });

  it('rejects English in a French scenario', () => {
    expect(passed('Tell me about a time a customer was unhappy.', 'language', 'fr')).toBe(false);
  });

  it('does not apply the language check to English scenarios', () => {
    expect(runChecks(GOOD).some((c) => c.check === 'language')).toBe(false);
  });
});

describe('empty output', () => {
  it('fails critically and stops further checks', () => {
    const results = runChecks('   ');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ check: 'non_empty', passed: false, critical: true });
  });
});
