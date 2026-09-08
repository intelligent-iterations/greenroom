/**
 * Single import point for the shared package.
 *
 * The harness deliberately reaches for the same prompt compiler, rubric and
 * scenario catalogue the product runs. If evals built their own copies they
 * would be measuring a system that does not ship, which is the most common way
 * an evaluation suite becomes decorative.
 */
export {
  CefrLevel,
  DimensionScore,
  JudgeVerdict,
  PROMPT_VERSION,
  RUBRIC,
  SPOKEN_RUBRIC,
  COACHING_RUBRIC,
  LANGUAGE_LEARNING_RUBRIC,
  SPOKEN_CHECKS,
  IN_CHARACTER_CHECKS,
  TURN_TAKING_CHECKS,
  COACHING_CHECKS,
  ALL_CHECKS,
  applicableRubric,
  SCENARIOS,
  SeniorityLevel,
  buildCorpus,
  buildJudgePrompt,
  compileInterviewerPrompt,
  compositeScore,
  criticalFailures,
  findScenario,
  LexicalRetriever,
  runChecks,
  checkFailures,
  criticalCheckFailures,
} from '@greenroom/shared';

export type {
  Check,
  RubricDimension,
  ChatMessage,
  CompiledPrompt,
  DimensionScore as Score,
  InterviewScenario,
  LearnerState,
  RubricDimensionId,
} from '@greenroom/shared';

export { z } from 'zod';
