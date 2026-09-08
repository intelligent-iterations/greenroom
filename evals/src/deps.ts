/**
 * Single import point for the shared package.
 *
 * Split along the same boundary the package is: the core is everything the
 * harness needs to evaluate *any* spoken agent, and the interview block is the
 * bundled example. A case that carries its own systemPrompt touches none of the
 * second block, which is the property that makes this harness reusable.
 *
 * The harness deliberately reaches for the same checks, rubric and prompt
 * compiler the product runs. If evals built their own copies they would be
 * measuring a system that does not ship, which is the most common way an
 * evaluation suite becomes decorative.
 */
export {
  ALL_CHECKS,
  COACHING_CHECKS,
  COACHING_RUBRIC,
  DimensionScore,
  IN_CHARACTER_CHECKS,
  JudgeVerdict,
  LANGUAGE_LEARNING_RUBRIC,
  LexicalRetriever,
  RUBRIC,
  SPOKEN_CHECKS,
  SPOKEN_RUBRIC,
  TURN_TAKING_CHECKS,
  applicableRubric,
  buildCorpus,
  buildJudgePrompt,
  checkFailures,
  compositeScore,
  criticalCheckFailures,
  criticalFailures,
  runChecks,
} from '@greenroom/shared';

export type {
  ChatMessage,
  Check,
  DimensionScore as Score,
  RubricDimension,
  RubricDimensionId,
} from '@greenroom/shared';

/** The bundled interview example. Only the scenario-backed cases reach these. */
export {
  CefrLevel,
  PROMPT_VERSION,
  SCENARIOS,
  SeniorityLevel,
  compileInterviewerPrompt,
  findScenario,
} from '@greenroom/shared/interview';

export type { CompiledPrompt, InterviewScenario, LearnerState } from '@greenroom/shared/interview';

export { z } from 'zod';
