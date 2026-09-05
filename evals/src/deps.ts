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
  SCENARIOS,
  SeniorityLevel,
  buildJudgePrompt,
  compileInterviewerPrompt,
  compositeScore,
  criticalFailures,
  findScenario,
} from '@greenroom/shared';

export type {
  ChatMessage,
  CompiledPrompt,
  DimensionScore as Score,
  InterviewScenario,
  LearnerState,
  RubricDimensionId,
} from '@greenroom/shared';

export { z } from 'zod';
