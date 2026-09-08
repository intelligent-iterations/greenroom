import { describe, expect, it } from 'vitest';
import {
  ALL_CHECKS,
  COACHING_CHECKS,
  IN_CHARACTER_CHECKS,
  SPOKEN_CHECKS,
  TURN_TAKING_CHECKS,
  runChecks,
  type CheckContext,
} from '../checks.js';

function result(turn: string, name: string, context: CheckContext = {}) {
  return runChecks(turn, context).find((c) => c.check === name);
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

  it.each([
    'Walk me through a system you owned from design into production.',
    'Tell me about a decision that turned out to be wrong.',
    'Describe the failure mode in as much detail as you can.',
    'Give me an example of that from your last team.',
  ])('accepts an imperative ask with no question mark: %s', (turn) => {
    // Requiring '?' would fail real interviewer phrasing, and a check that
    // fails good output is worse than none.
    expect(result(turn, 'asks_a_question')?.passed).toBe(true);
  });
});

describe('asks_a_question: turns that legitimately ask nothing', () => {
  it.each([
    // Declining to supply the answer, floor handed back.
    'I would rather not steer you. Answer it however it makes sense to you.',
    // Refusing a protected-characteristic invitation and redirecting.
    'That is not something I ask about. Let us stay on the decision itself.',
    // Answering a scoping question briefly, then yielding.
    'Canada only, and assume public hospitals rather than private clinics. Go ahead.',
  ])('accepts a turn that returns the floor: %s', (turn) => {
    expect(result(turn, 'asks_a_question')?.passed).toBe(true);
  });

  it('accepts a French imperative ask', () => {
    expect(
      result("Bonjour. Pour commencer, parlez-moi d'une fois où un client était mécontent.", 'asks_a_question')
        ?.passed,
    ).toBe(true);
  });

  it('still fails a turn that neither asks nor yields', () => {
    expect(result('That sounds like a really challenging project.', 'asks_a_question')?.passed).toBe(
      false,
    );
  });
});

describe('asks_a_question: imperative asks with a wh-word', () => {
  // Both of these are real turns from the first live run against a hosted
  // model. They ask plainly, and the check failed them, because the pattern
  // wanted "tell me about" and they said "tell me what".
  it('accepts "tell me what you built"', () => {
    const turn =
      'I want your real answer, not mine. Just tell me what you built, the decisions you made, and how it ended up in production.';
    expect(result(turn, 'asks_a_question')?.passed).toBe(true);
  });

  it('accepts "tell me how you would narrow it down"', () => {
    const turn = "Let's say North America to start, and tell me how you would narrow it down from there.";
    expect(result(turn, 'asks_a_question')?.passed).toBe(true);
  });

  it('accepts "start me from wherever you would begin"', () => {
    const turn = "Let's say North America. Start me from wherever you'd begin.";
    expect(result(turn, 'asks_a_question')?.passed).toBe(true);
  });

  it('still fails a turn that only makes a statement', () => {
    expect(result('That is a good place to leave it.', 'asks_a_question')?.passed).toBe(false);
  });
});

describe('no_assistant_voice', () => {
  it.each([
    'How can I help you today?',
    'Let me know if you want to move on.',
    'Feel free to take your time.',
    'Thanks for sharing that. What else?',
    'Great question. What did you build?',
  ])('rejects assistant voice: %s', (turn) => {
    expect(result(turn, 'no_assistant_voice')?.passed).toBe(false);
  });

  it('accepts a plain interviewer turn', () => {
    expect(result('What did you measure afterwards?', 'no_assistant_voice')?.passed).toBe(true);
  });
});

describe('not_echoing', () => {
  const answer = 'I rebuilt the billing pipeline because it kept falling over during month end.';

  it('fails a turn that restates the candidate back at them', () => {
    const turn = 'So you rebuilt the billing pipeline because it kept falling over during month end?';
    expect(result(turn, 'not_echoing', { lastUserTurn: answer })?.passed).toBe(false);
  });

  it('passes a turn that probes instead of restating', () => {
    const turn = 'What was the failure mode exactly, and how often did it happen?';
    expect(result(turn, 'not_echoing', { lastUserTurn: answer })?.passed).toBe(true);
  });

  it('is skipped when there is no previous answer', () => {
    expect(result('Walk me through a system you owned.', 'not_echoing')).toBeUndefined();
  });
});

describe('not_repeating', () => {
  const asked = ['Walk me through a system you owned from design to production.'];

  it('fails a near-duplicate of an earlier question', () => {
    const turn = 'Walk me through a system you owned from design into production.';
    expect(result(turn, 'not_repeating', { previousAgentTurns: asked })?.passed).toBe(false);
  });

  it('passes a genuinely new question', () => {
    const turn = 'What decision on that team turned out to be wrong?';
    expect(result(turn, 'not_repeating', { previousAgentTurns: asked })).toBeUndefined();
  });

  // The adversarial derail case exists to reward exactly this turn. A check
  // that failed it would fail the build for the interviewer doing its job.
  it('allows re-asking a question the candidate dodged', () => {
    const turn = 'Another time, gladly. Walk me through a system you owned from design to production.';
    const dodge = 'Before that, what is your favourite programming language? I could talk about it all day.';
    expect(
      result(turn, 'not_repeating', {
        previousAgentTurns: asked,
        lastUserTurn: dodge,
      }),
    ).toBeUndefined();
  });

  it('still fails a repeat of a question the candidate did answer', () => {
    const turn = 'Walk me through a system you owned from design into production.';
    const answer = 'I owned the billing system end to end, from the design docs through production rollout.';
    expect(
      result(turn, 'not_repeating', {
        previousAgentTurns: asked,
        lastUserTurn: answer,
      })?.passed,
    ).toBe(false);
  });
});

describe('not_reciting_context', () => {
  const passage = 'Led a Kafka migration that cut checkout latency in half across the payments team.';

  it('fails a turn that reads its context back at the candidate', () => {
    const turn = `Led a Kafka migration that cut checkout latency in half across the payments team. Tell me about that.`;
    expect(result(turn, 'not_reciting_context', { injectedPassages: [passage] })?.passed).toBe(false);
  });

  // Quoting a phrase back is how an interviewer shows it was listening. A
  // check that failed this would fail correct behaviour.
  it('stays quiet when a turn only quotes a short phrase back', () => {
    const turn = 'You mentioned the Kafka migration. What did the latency settle at?';
    expect(result(turn, 'not_reciting_context', { injectedPassages: [passage] })).toBeUndefined();
  });

  it('stays absent when no passages were injected', () => {
    expect(result('What did the latency settle at?', 'not_reciting_context')).toBeUndefined();
  });
});

describe('a clean interviewer turn still passes everything', () => {
  it('has no failures', () => {
    const turn = 'What did the latency settle at after the change?';
    const failures = runChecks(turn, {
      lastUserTurn: 'We moved to an event driven queue and it got much faster.',
      previousAgentTurns: ['Walk me through a system you owned.'],
    }).filter((c) => !c.passed);
    expect(failures).toEqual([]);
  });
});

describe('composable packs', () => {
  const statement = 'That sounds like a challenging project.';

  // Choosing the wrong pack is a real failure in both directions: a support
  // agent answering a question must not be failed for asking nothing, and an
  // examiner must not be let off for giving the answer away.
  it('does not demand a question when turn-taking is not selected', () => {
    const names = runChecks(statement, {}, SPOKEN_CHECKS).map((c) => c.check);
    expect(names).not.toContain('asks_a_question');
  });

  it('demands one when it is', () => {
    const result = runChecks(statement, {}, TURN_TAKING_CHECKS)[0];
    expect(result).toMatchObject({ check: 'asks_a_question', passed: false, critical: true });
  });

  it('only polices answer leakage for a coaching agent', () => {
    const leak = 'A strong answer would mention idempotency. What would you say?';
    expect(runChecks(leak, {}, SPOKEN_CHECKS).map((c) => c.check)).not.toContain(
      'no_answer_leakage',
    );
    expect(runChecks(leak, {}, COACHING_CHECKS).find((c) => c.check === 'no_answer_leakage')?.passed).toBe(
      false,
    );
  });

  it('only polices assistant voice for an in-character agent', () => {
    const helpful = 'Happy to help. What would you like to cover?';
    expect(runChecks(helpful, {}, SPOKEN_CHECKS).every((c) => c.passed)).toBe(true);
    expect(
      runChecks(helpful, {}, IN_CHARACTER_CHECKS).find((c) => c.check === 'no_assistant_voice')
        ?.passed,
    ).toBe(false);
  });

  it('composes packs', () => {
    const names = runChecks(statement, {}, [...SPOKEN_CHECKS, ...TURN_TAKING_CHECKS]).map(
      (c) => c.check,
    );
    expect(names).toContain('speakable');
    expect(names).toContain('asks_a_question');
  });

  // Eleven failures for one cause is a worse report than one failure.
  it('short-circuits on an empty turn instead of reporting every check', () => {
    const results = runChecks('   ', {}, ALL_CHECKS);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ check: 'non_empty', passed: false });
  });

  it('stays silent on checks whose context this turn did not carry', () => {
    const names = runChecks('What did it cost you?', {}, SPOKEN_CHECKS).map((c) => c.check);
    expect(names).not.toContain('not_echoing');
    expect(names).not.toContain('not_reciting_context');
    expect(names).not.toContain('language');
  });
});
