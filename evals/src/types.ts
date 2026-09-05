import { CefrLevel, SeniorityLevel, z, type Score } from './deps.ts';
import type { CheckResult } from '@greenroom/shared';

/**
 * A single evaluation case.
 *
 * A case is a *situation*, not an expected answer. There is no single correct
 * interviewer turn, so the harness scores the properties a good turn must have
 * rather than diffing against a golden string — golden-output tests on
 * generative systems fail on paraphrase and pass on nonsense.
 */
export const EvalCase = z.object({
  id: z.string().min(1),
  /** Scenario id from the shared catalogue. */
  scenario: z.string().min(1),
  /** One line on what this case is probing, shown in the report. */
  probes: z.string().min(1),
  /** Learner-state overrides. Everything unset uses the fixture default. */
  learner: z
    .object({
      cefr: CefrLevel.optional(),
      seniority: SeniorityLevel.optional(),
      sessionsCompleted: z.number().int().optional(),
    })
    .default({}),
  /** Conversation before the turn under test. Empty means the opening turn. */
  transcript: z
    .array(z.object({ role: z.enum(['interviewer', 'learner']), text: z.string() }))
    .default([]),
  /**
   * The turn the replay backend serves for this case.
   *
   * The committed values are HAND-AUTHORED exemplars, not captured model
   * output. They exist so the harness, the checks and the gate can be run and
   * reviewed offline with no vendor account. Running `--record` against a live
   * backend overwrites them with real captures, and that is what a release
   * baseline should be measured on — see docs/EVALUATION.md.
   */
  referenceTurn: z.string().optional(),
  /** Tags for slicing the report: 'adversarial', 'fr', 'calibration'. */
  tags: z.array(z.string()).default([]),
});
export type EvalCase = z.infer<typeof EvalCase>;

export interface CaseResult {
  case: EvalCase;
  turn: string;
  checks: CheckResult[];
  scores: Score[];
  composite: number;
  criticalFailures: string[];
  /** Set when the case could not be scored at all. */
  error?: string;
}

export interface EvalReport {
  startedAt: string;
  promptVersion: string;
  modelId: string;
  judgeId: string;
  results: CaseResult[];
  summary: {
    cases: number;
    scored: number;
    errors: number;
    composite: number;
    byDimension: Record<string, number>;
    criticalFailures: number;
    checkFailures: number;
  };
}
