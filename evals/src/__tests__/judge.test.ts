import { describe, expect, it } from 'vitest';
import type { EvalBackend } from '../backends.ts';
import { RUBRIC, applicableRubric } from '../deps.ts';
import { extractJson, judgeTurn } from '../judge.ts';

const TURN = 'A lot faster is doing some work there. What was the latency before you touched it?';

/** Returns each scripted response in turn, so retries can be exercised. */
function backendOf(...responses: string[]): EvalBackend & { calls: number } {
  let calls = 0;
  return {
    id: 'fake-judge',
    get calls() {
      return calls;
    },
    async complete() {
      const response = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return response;
    },
  };
}

/**
 * A verdict covering the dimensions the judge was actually asked for.
 *
 * `input` below carries no passages, so grounding is not on the rubric the
 * judge sees — and a score for it would be discarded as unasked.
 */
function verdict(evidence: string, scores = 4): string {
  return JSON.stringify({
    scores: applicableRubric().map((d) => ({ dimension: d.id, score: scores, evidence })),
    headline: '',
  });
}

const input = {
  agentSystemPrompt: 'system',
  transcript: 'Candidate: it was a lot faster',
  turnUnderTest: TURN,
};

describe('extractJson', () => {
  it('recovers an object from a fenced or prose-wrapped response', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a":1}')).toEqual({ a: 1 });
    expect(extractJson('not json')).toBeUndefined();
  });
});

describe('judgeTurn evidence verification', () => {
  it('keeps scores whose evidence appears in the turn', async () => {
    const result = await judgeTurn(backendOf(verdict('What was the latency before you touched it')), input);
    expect(result.scores).toHaveLength(applicableRubric().length);
    expect(result.discarded).toBe(0);
  });

  it('tolerates punctuation and case differences in the quote', async () => {
    const result = await judgeTurn(backendOf(verdict('what was the latency, before you touched it?')), input);
    expect(result.discarded).toBe(0);
  });

  it('retries when the judge quotes something that is not in the turn', async () => {
    const backend = backendOf(
      verdict('the candidate mentioned Kubernetes'),
      verdict('What was the latency before you touched it'),
    );
    const result = await judgeTurn(backend, input);
    expect(backend.calls).toBe(2);
    expect(result.discarded).toBe(0);
  });

  it('gives up rather than scoring a case on fabricated evidence', async () => {
    await expect(judgeTurn(backendOf(verdict('entirely invented quotation')), input)).rejects.toThrow(
      /unverifiable evidence/,
    );
  });

  it('retries on unparseable output and then fails cleanly', async () => {
    const backend = backendOf('I think the turn was pretty good, honestly.');
    await expect(judgeTurn(backend, input)).rejects.toThrow(/Judge failed after 3 attempts/);
    expect(backend.calls).toBe(3);
  });

  it('recovers when a retry returns valid JSON', async () => {
    const backend = backendOf('sorry!', verdict('What was the latency before you touched it'));
    const result = await judgeTurn(backend, input);
    expect(backend.calls).toBe(2);
    expect(result.scores).toHaveLength(applicableRubric().length);
  });
});

describe('judgeTurn dimension scope', () => {
  const quote = 'What was the latency before you touched it';

  // A judge scoring a dimension it was not shown is not being generous: it is
  // working from its own idea of the rubric, and that score would enter a
  // dimension mean that most cases never populate.
  it('discards a score for a dimension it was not asked about', async () => {
    const withGrounding = JSON.stringify({
      scores: RUBRIC.map((d) => ({ dimension: d.id, score: 4, evidence: quote })),
      headline: '',
    });
    const result = await judgeTurn(backendOf(withGrounding), input);
    expect(result.scores.map((s) => s.dimension)).not.toContain('grounding');
    expect(result.discarded).toBe(1);
  });

  it('keeps a grounding score when the interviewer was actually given context', async () => {
    const withGrounding = JSON.stringify({
      scores: RUBRIC.map((d) => ({ dimension: d.id, score: 4, evidence: quote })),
      headline: '',
    });
    const result = await judgeTurn(backendOf(withGrounding), {
      ...input,
      passages: ['The team runs Postgres.'],
    });
    expect(result.scores.map((s) => s.dimension)).toContain('grounding');
    expect(result.discarded).toBe(0);
  });
});
