import { describe, expect, it } from 'vitest';
import { runChecks } from '../checks.js';
import { findScenario } from '../scenarios.js';

const en = findScenario('backend-mid-en')!;

function result(turn: string, name: string, context = {}) {
  return runChecks(turn, en, context).find((c) => c.check === name);
}

/**
 * These cover the failure a live session found and the previous checks missed:
 * turns that are clean, short, well-formed prose and simply are not an
 * interview. Every check here has a case proving it fires and a case proving
 * it stays quiet, because a check that cannot fail only looks like coverage.
 */
describe('asks_a_question', () => {
  it('fails a turn that asks nothing', () => {
    // The reported failure: fluent, in-role-sounding, not an interview.
    expect(result('That sounds like a challenging project.', 'asks_a_question')).toMatchObject({
      passed: false,
      critical: true,
    });
  });

  it('passes a turn that asks something', () => {
    expect(result('What did the latency settle at?', 'asks_a_question')?.passed).toBe(true);
  });
});

describe('interviewer_register', () => {
  it.each([
    'How can I help you today?',
    'Let me know if you want to move on.',
    'Feel free to take your time.',
    'Thanks for sharing that. What else?',
    'Great question. What did you build?',
  ])('rejects assistant voice: %s', (turn) => {
    expect(result(turn, 'interviewer_register')?.passed).toBe(false);
  });

  it('accepts a plain interviewer turn', () => {
    expect(result('What did you measure afterwards?', 'interviewer_register')?.passed).toBe(true);
  });
});

describe('not_echoing', () => {
  const answer = 'I rebuilt the billing pipeline because it kept falling over during month end.';

  it('fails a turn that restates the candidate back at them', () => {
    const turn = 'So you rebuilt the billing pipeline because it kept falling over during month end?';
    expect(result(turn, 'not_echoing', { lastCandidateAnswer: answer })?.passed).toBe(false);
  });

  it('passes a turn that probes instead of restating', () => {
    const turn = 'What was the failure mode exactly, and how often did it happen?';
    expect(result(turn, 'not_echoing', { lastCandidateAnswer: answer })?.passed).toBe(true);
  });

  it('is skipped when there is no previous answer', () => {
    expect(result('Walk me through a system you owned.', 'not_echoing')).toBeUndefined();
  });
});

describe('not_repeating', () => {
  const asked = ['Walk me through a system you owned from design to production.'];

  it('fails a near-duplicate of an earlier question', () => {
    const turn = 'Walk me through a system you owned from design into production.';
    expect(result(turn, 'not_repeating', { previousInterviewerTurns: asked })?.passed).toBe(false);
  });

  it('passes a genuinely new question', () => {
    const turn = 'What decision on that team turned out to be wrong?';
    expect(result(turn, 'not_repeating', { previousInterviewerTurns: asked })).toBeUndefined();
  });
});

describe('a clean interviewer turn still passes everything', () => {
  it('has no failures', () => {
    const turn = 'What did the latency settle at after the change?';
    const failures = runChecks(turn, en, {
      lastCandidateAnswer: 'We moved to an event driven queue and it got much faster.',
      previousInterviewerTurns: ['Walk me through a system you owned.'],
    }).filter((c) => !c.passed);
    expect(failures).toEqual([]);
  });
});
