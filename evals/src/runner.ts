import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runChecks, criticalCheckFailures } from './checks.ts';
import { LexicalRetriever, buildCorpus } from './deps.ts';
import {
  PROMPT_VERSION,
  RUBRIC,
  compileInterviewerPrompt,
  compositeScore,
  criticalFailures,
  findScenario,
  type ChatMessage,
  type LearnerState,
  type Score,
} from './deps.ts';
import { judgeTurn } from './judge.ts';
import type { EvalBackend } from './backends.ts';
import { ReplayBackend } from './backends.ts';
import { EvalCase, type CaseResult, type EvalReport } from './types.ts';

/** Loads every .jsonl file in a directory as evaluation cases. */
export async function loadCases(dir: string): Promise<EvalCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const cases: EvalCase[] = [];

  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        throw new Error(`${file}:${index + 1} is not valid JSON`);
      }

      const parsed = EvalCase.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`${file}:${index + 1} ${parsed.error.issues[0]?.message ?? 'invalid case'}`);
      }
      cases.push(parsed.data);
    }
  }

  const ids = new Set<string>();
  for (const c of cases) {
    // Case ids key the recordings, so a duplicate would silently make one case
    // replay the other's turn and quietly pass.
    if (ids.has(c.id)) throw new Error(`Duplicate case id "${c.id}"`);
    ids.add(c.id);
  }

  return cases;
}

/** The learner profile a case is scored against, before its own overrides. */
const BASE_LEARNER: LearnerState = {
  userId: 'eval',
  cefr: 'B2',
  seniority: 'mid',
  language: 'en',
  targetRole: 'Backend Engineer',
  mastery: [],
  recentErrors: [],
  sessionsCompleted: 5,
  updatedAt: 0,
  documents: [],
};

export interface RunOptions {
  backend: EvalBackend;
  /**
   * Which prompt the model under test runs.
   *
   * On-device models cannot follow the full prompt — measured, not assumed —
   * so a harness that only ever compiles the full one is scoring a
   * configuration those models never run.
   */
  promptStyle?: 'full' | 'compact';
  /** Undefined runs deterministic checks only — the zero-secrets CI path. */
  judge?: EvalBackend;
  /** Called after each case so a long run reports progress. */
  onProgress?: (result: CaseResult, index: number, total: number) => void;
  /** Cases run at once. Vendor rate limits make more than a few pointless. */
  concurrency?: number;
}

export async function runCase(
  testCase: EvalCase,
  options: RunOptions,
): Promise<CaseResult> {
  const scenario = findScenario(testCase.scenario);
  if (!scenario) {
    return emptyResult(testCase, `unknown scenario "${testCase.scenario}"`);
  }

  const learner: LearnerState = {
    ...BASE_LEARNER,
    seniority: scenario.seniority,
    language: scenario.language,
    ...testCase.learner,
  };

  // The same retrieval the session does, from the same corpus builder, so the
  // harness scores the prompt that ships rather than one it made up. Cases with
  // no documents and a scenario with no notes retrieve nothing and compile
  // exactly as they did before grounding existed.
  const question = scenario.requiredQuestions[0] ?? scenario.role;
  const lastAnswer = [...testCase.transcript].reverse().find((t) => t.role === 'learner')?.text;
  const retriever = new LexicalRetriever();
  await retriever.index(
    buildCorpus(
      scenario,
      testCase.documents.map((d) => ({ ...d, updatedAt: 0 })),
    ),
  );
  const passages = await retriever.retrieve({
    question,
    ...(lastAnswer ? { lastAnswer } : {}),
    limit: options.promptStyle === 'compact' ? 1 : 4,
  });

  const prompt = compileInterviewerPrompt({
    scenario,
    learner,
    ...(options.promptStyle ? { style: options.promptStyle } : {}),
    ...(scenario.requiredQuestions[0] ? { nextQuestion: scenario.requiredQuestions[0] } : {}),
    ...(passages.length > 0 ? { passages } : {}),
  });
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    ...testCase.transcript.map((t): ChatMessage => ({
      role: t.role === 'interviewer' ? 'assistant' : 'user',
      content: t.text,
    })),
  ];

  let turn: string;
  try {
    if (options.backend instanceof ReplayBackend) options.backend.select(testCase.id);
    turn = (await options.backend.complete(messages, { maxTokens: 200 })).trim();
  } catch (err) {
    return emptyResult(testCase, err instanceof Error ? err.message : String(err));
  }

  // The context matters: without it `not_echoing` and `not_repeating` are
  // present in every report and can never fire, which is the "looks like
  // coverage" failure checks.ts warns about. The transcript the case already
  // carries is exactly what they need.
  const previousInterviewerTurns = testCase.transcript
    .filter((t) => t.role === 'interviewer')
    .map((t) => t.text);
  const lastCandidateAnswer = [...testCase.transcript]
    .reverse()
    .find((t) => t.role === 'learner')?.text;

  const checks = runChecks(turn, scenario, {
    ...(previousInterviewerTurns.length ? { previousInterviewerTurns } : {}),
    ...(lastCandidateAnswer ? { lastCandidateAnswer } : {}),
    ...(passages.length > 0 ? { injectedPassages: passages.map((p) => p.text) } : {}),
  });

  let scores: Score[] = [];
  if (options.judge) {
    try {
      const verdict = await judgeTurn(options.judge, {
        ...(passages.length > 0 ? { passages: passages.map((p) => p.text) } : {}),
        interviewerSystemPrompt: prompt.system,
        transcript: testCase.transcript
          .map((t) => `${t.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
          .join('\n'),
        turnUnderTest: turn,
      });
      scores = verdict.scores;
    } catch (err) {
      return {
        case: testCase,
        turn,
        checks,
        scores: [],
        composite: 0,
        criticalFailures: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    case: testCase,
    turn,
    checks,
    scores,
    composite: scores.length > 0 ? compositeScore(scores) : 0,
    criticalFailures: [
      ...criticalFailures(scores).map((s) => s.dimension as string),
      ...criticalCheckFailures(checks).map((c) => `check:${c.check}`),
    ],
  };
}

function emptyResult(testCase: EvalCase, error: string): CaseResult {
  return { case: testCase, turn: '', checks: [], scores: [], composite: 0, criticalFailures: [], error };
}

export async function runSuite(cases: EvalCase[], options: RunOptions): Promise<EvalReport> {
  const results: CaseResult[] = new Array(cases.length);
  const concurrency = Math.max(1, options.concurrency ?? 4);
  let next = 0;
  let completed = 0;

  // A simple worker pool rather than Promise.all over everything: firing forty
  // cases at a vendor at once earns a 429 and a run that fails for a reason
  // that has nothing to do with quality.
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (true) {
        const index = next++;
        const testCase = cases[index];
        if (!testCase) return;
        const result = await runCase(testCase, options);
        results[index] = result;
        options.onProgress?.(result, ++completed, cases.length);
      }
    }),
  );

  return buildReport(results, options);
}

function buildReport(results: CaseResult[], options: RunOptions): EvalReport {
  const scored = results.filter((r) => !r.error && r.scores.length > 0);
  const errors = results.filter((r) => r.error);

  const byDimension: Record<string, number> = {};
  for (const dim of RUBRIC) {
    const values = scored
      .map((r) => r.scores.find((s) => s.dimension === dim.id)?.score)
      .filter((v): v is number => v !== undefined);
    if (values.length > 0) {
      byDimension[dim.id] = values.reduce((a, b) => a + b, 0) / values.length;
    }
  }

  return {
    startedAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    modelId: options.backend.id,
    judgeId: options.judge?.id ?? 'none (deterministic checks only)',
    results,
    summary: {
      cases: results.length,
      scored: scored.length,
      errors: errors.length,
      composite:
        scored.length > 0 ? scored.reduce((a, r) => a + r.composite, 0) / scored.length : 0,
      byDimension,
      criticalFailures: results.filter((r) => r.criticalFailures.length > 0).length,
      checkFailures: results.reduce((a, r) => a + r.checks.filter((c) => !c.passed).length, 0),
    },
  };
}
