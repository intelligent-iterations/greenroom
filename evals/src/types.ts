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
  /** One line on what this case is probing, shown in the report. */
  probes: z.string().min(1),
  /**
   * The agent under test, supplied directly.
   *
   * The general path, and the one to use for your own agent: a case carries the
   * prompt its agent runs under, and the harness needs to know nothing else
   * about what that agent is for.
   */
  systemPrompt: z.string().min(1).optional(),
  /** Language the turn is expected to be in, when it matters. */
  language: z.string().optional(),
  /** Facts the agent already knows. Added to the retrieval corpus. */
  contextNotes: z.array(z.string()).default([]),
  /**
   * A bundled example agent to compile a prompt from instead.
   *
   * Sugar for the interview example that ships with this repo. Ignored when
   * `systemPrompt` is set.
   */
  scenario: z.string().min(1).optional(),
  /**
   * Which check packs apply to this agent.
   *
   * Defaults to all of them, which is right for the bundled interview example
   * and wrong for most other agents: a support agent answering a question must
   * not be failed by `asks_a_question`, and an agent whose job is explaining
   * must not be failed by `no_answer_leakage`.
   */
  checkPacks: z.array(z.enum(['spoken', 'in_character', 'turn_taking', 'coaching'])).optional(),
  /** Which rubric packs to score against. Defaults to all. */
  rubricPacks: z.array(z.enum(['spoken', 'coaching', 'language_learning'])).optional(),
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
    .array(
      z.object({
        // 'interviewer' and 'learner' are the older names, still accepted so
        // the bundled datasets keep parsing. New cases should say agent/user.
        role: z
          .enum(['agent', 'user', 'interviewer', 'learner'])
          .transform((r) => (r === 'interviewer' ? 'agent' : r === 'learner' ? 'user' : r)),
        text: z.string(),
      }),
    )
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
  /**
   * Documents the learner supplied, for grounding cases.
   *
   * Carried on the case rather than fetched, so the harness stays offline and
   * a grounding regression is reproducible from the dataset alone.
   */
  documents: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(['cv', 'job_description', 'notes']).default('cv'),
        title: z.string().min(1).max(120).default('Document'),
        text: z.string().max(20_000),
      }),
    )
    .default([]),
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
