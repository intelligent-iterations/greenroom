import { z } from 'zod';

/**
 * Core domain model.
 *
 * These types are the contract between the three surfaces that need to agree:
 * the browser pipeline, the Cloud Functions learner-state layer, and the
 * offline evaluation harness. Anything that crosses one of those boundaries is
 * validated with the zod schema rather than trusted, because two of the three
 * are reachable by a client we do not control.
 */

/** CEFR band. Drives lexical ceiling and speech rate, not question difficulty. */
export const CefrLevel = z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
export type CefrLevel = z.infer<typeof CefrLevel>;

/** Career seniority. Drives question difficulty, not language complexity. */
export const SeniorityLevel = z.enum(['intern', 'junior', 'mid', 'senior', 'staff']);
export type SeniorityLevel = z.infer<typeof SeniorityLevel>;

export const InterviewLanguage = z.enum(['en', 'fr']);
export type InterviewLanguage = z.infer<typeof InterviewLanguage>;

/**
 * A trainable competency. Kept as a closed set so mastery estimates stay
 * comparable across sessions and so the rubric can address them by id.
 */
export const CompetencyId = z.enum([
  'structured_storytelling', // STAR / CAR narrative shape
  'technical_depth', // can defend specifics under follow-up
  'quantified_impact', // attaches numbers to outcomes
  'active_listening', // answers the question actually asked
  'concision', // gets to the point inside ~90s
  'domain_vocabulary', // uses the register of the field
  'handling_pressure', // stays coherent when challenged
  'clarifying_questions', // scopes ambiguous questions before answering
]);
export type CompetencyId = z.infer<typeof CompetencyId>;

export const COMPETENCY_LABELS: Record<CompetencyId, string> = {
  structured_storytelling: 'Structured storytelling',
  technical_depth: 'Technical depth',
  quantified_impact: 'Quantified impact',
  active_listening: 'Active listening',
  concision: 'Concision',
  domain_vocabulary: 'Domain vocabulary',
  handling_pressure: 'Handling pressure',
  clarifying_questions: 'Clarifying questions',
};

/**
 * Per-competency mastery estimate.
 *
 * `score` is an exponentially weighted mean in [0,1]; `observations` is the
 * number of scored turns behind it. Both are needed: a 0.9 from one turn and a
 * 0.9 from forty turns should not drive the same pedagogical decision, so the
 * prompt compiler treats anything under MIN_CONFIDENT_OBSERVATIONS as unproven
 * rather than mastered.
 */
export const CompetencyMastery = z.object({
  competency: CompetencyId,
  score: z.number().min(0).max(1),
  observations: z.number().int().min(0),
  updatedAt: z.number().int(),
});
export type CompetencyMastery = z.infer<typeof CompetencyMastery>;

export const MIN_CONFIDENT_OBSERVATIONS = 3;

/** A recurring error worth surfacing back to the learner. */
export const ObservedError = z.object({
  competency: CompetencyId,
  /** Short, learner-facing description. Written by the coach model. */
  note: z.string().max(280),
  /** How many sessions this has been seen in. Drives whether we re-raise it. */
  occurrences: z.number().int().min(1),
  lastSeenAt: z.number().int(),
});
export type ObservedError = z.infer<typeof ObservedError>;

/**
 * Everything the prompt layer knows about the learner. This is the
 * "learner-state layer" the pipeline is calibrated against; it is the only
 * user-specific input to prompt compilation.
 */
export const LearnerState = z.object({
  userId: z.string().min(1),
  cefr: CefrLevel,
  seniority: SeniorityLevel,
  language: InterviewLanguage,
  targetRole: z.string().min(1).max(120),
  mastery: z.array(CompetencyMastery),
  recentErrors: z.array(ObservedError).max(10),
  sessionsCompleted: z.number().int().min(0),
  updatedAt: z.number().int(),
});
export type LearnerState = z.infer<typeof LearnerState>;

/**
 * The pedagogical content a session is run against. In the product this is
 * authored content; in the eval harness it is a fixture. Same shape either way,
 * which is what lets held-out scenarios be replayed offline.
 */
export const InterviewScenario = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Who the model is playing. */
  interviewerPersona: z.string().min(1).max(600),
  company: z.string().min(1).max(120),
  role: z.string().min(1).max(120),
  seniority: SeniorityLevel,
  language: InterviewLanguage,
  /** Competencies this scenario is designed to exercise, in priority order. */
  targetCompetencies: z.array(CompetencyId).min(1),
  /** Seed questions. The model may follow up freely but must cover these. */
  requiredQuestions: z.array(z.string().min(1)).min(1),
  /** Facts the interviewer knows and may probe. Grounding for the RAG path. */
  contextNotes: z.array(z.string()).default([]),
  /** Hard limit on turns before the session wraps into feedback. */
  maxTurns: z.number().int().min(2).max(40).default(10),
});
export type InterviewScenario = z.infer<typeof InterviewScenario>;

export const TurnRole = z.enum(['interviewer', 'learner', 'system']);
export type TurnRole = z.infer<typeof TurnRole>;

export const Turn = z.object({
  id: z.string().min(1),
  role: TurnRole,
  text: z.string(),
  startedAt: z.number().int(),
  /** Wall-clock ms this turn occupied, mic-open to audio-complete. */
  durationMs: z.number().min(0).optional(),
  /** STT confidence when the turn came from speech. */
  asrConfidence: z.number().min(0).max(1).optional(),
  /** True when the learner cut the interviewer off mid-sentence. */
  bargedIn: z.boolean().optional(),
});
export type Turn = z.infer<typeof Turn>;

export const SessionRecord = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  scenarioId: z.string().min(1),
  startedAt: z.number().int(),
  endedAt: z.number().int().optional(),
  turns: z.array(Turn),
  /** Which model actually served the session; see routing.ts. */
  modelId: z.string(),
  /** Prompt template version, so a regression can be traced to a prompt change. */
  promptVersion: z.string(),
  /** Aggregated stage latencies, p50/p95 over the session. */
  latency: z
    .object({
      sttMsP50: z.number().optional(),
      firstTokenMsP50: z.number().optional(),
      firstAudioMsP50: z.number().optional(),
      turnaroundMsP50: z.number().optional(),
      turnaroundMsP95: z.number().optional(),
    })
    .optional(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

/** Look up a mastery estimate, treating "never observed" as a distinct case. */
export function masteryFor(
  state: LearnerState,
  competency: CompetencyId,
): CompetencyMastery | undefined {
  return state.mastery.find((m) => m.competency === competency);
}

/**
 * Exponentially weighted update of a mastery estimate.
 *
 * Alpha decays with observation count so early sessions move the estimate
 * quickly and later ones do not thrash it: a learner who has been scored forty
 * times should not drop a band because of one bad turn.
 */
export function updateMastery(
  competency: CompetencyId,
  prior: CompetencyMastery | undefined,
  observed: number,
  now: number,
): CompetencyMastery {
  if (!prior) {
    return { competency, score: observed, observations: 1, updatedAt: now };
  }
  const alpha = Math.max(0.1, 1 / (prior.observations + 1));
  return {
    competency,
    score: prior.score * (1 - alpha) + observed * alpha,
    observations: prior.observations + 1,
    updatedAt: now,
  };
}
