import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ALL_CHECKS, IN_CHARACTER_CHECKS, SPOKEN_CHECKS, runChecks } from '../deps.ts';
import { EvalCase } from '../types.ts';

/**
 * Evidence that composing packs is load-bearing rather than decorative.
 *
 * A support agent answering a caller's question is doing its job. Scored with
 * the interview packs it fails a *critical* check for not asking a question
 * back, which would have made this harness unusable for any agent that is not
 * an interviewer — the exact thing the packs exist to fix.
 */
function supportCases() {
  return readFileSync('datasets/support-agent.jsonl', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l) => EvalCase.parse(JSON.parse(l)));
}

describe('pack selection', () => {
  const answering = supportCases().find((c) => c.id === 'support-answers-directly')!;

  it('passes a support turn under the packs that agent selected', () => {
    const failures = runChecks(
      answering.referenceTurn!,
      {},
      [...SPOKEN_CHECKS, ...IN_CHARACTER_CHECKS],
    ).filter((c) => !c.passed);
    expect(failures).toEqual([]);
  });

  it('fails the same turn critically under the interview packs', () => {
    const failures = runChecks(answering.referenceTurn!, {}, ALL_CHECKS).filter((c) => !c.passed);
    expect(failures.map((f) => f.check)).toContain('asks_a_question');
    expect(failures.find((f) => f.check === 'asks_a_question')?.critical).toBe(true);
  });

  it('carries its own agent, needing nothing from the interview domain', () => {
    for (const c of supportCases()) {
      expect(c.systemPrompt, c.id).toBeDefined();
      expect(c.scenario, c.id).toBeUndefined();
    }
  });

  // The older role names still parse, so the bundled interview datasets keep
  // working while new cases use the general vocabulary.
  it('accepts both the old and the new transcript role names', () => {
    const old = EvalCase.parse({
      id: 'x',
      probes: 'p',
      systemPrompt: 's',
      transcript: [{ role: 'interviewer', text: 'a' }, { role: 'learner', text: 'b' }],
    });
    expect(old.transcript.map((t) => t.role)).toEqual(['agent', 'user']);
  });
});
