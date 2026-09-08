import { z } from 'zod';
import { BUILT_IN_PRESETS, VoicePreset } from '../presets.js';
import { compileInterviewerPrompt, type PromptStyle } from './prompt.js';
import { SCENARIOS } from './scenarios.js';
import type { InterviewLanguage, LearnerState } from './domain.js';

/**
 * The interview preset, built from the pedagogical prompt compiler.
 *
 * Kept as a preset rather than a special case so the playground and the
 * training tool run the identical loop. The compiler still owns CEFR register,
 * seniority calibration and focus selection.
 */
export function interviewPreset(
  scenarioId: string,
  learner: LearnerState,
  style: PromptStyle = 'compact',
): VoicePreset | undefined {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) return undefined;

  const compiled = compileInterviewerPrompt({
    scenario,
    learner,
    style,
    ...(scenario.requiredQuestions[0] ? { nextQuestion: scenario.requiredQuestions[0] } : {}),
  });

  return VoicePreset.parse({
    id: `interview:${scenario.id}`,
    title: scenario.title,
    description: `Practice interview — ${scenario.company}`,
    language: scenario.language satisfies InterviewLanguage,
    systemPrompt: compiled.system,
    openingMessage: "I'm ready to begin.",
    maxTurns: scenario.maxTurns,
    scenarioId: scenario.id,
  });
}


/**
 * The built-in partners plus one preset per bundled interview scenario.
 *
 * Lives here rather than in the core because it is the only preset helper that
 * knows what a learner is.
 */
export function allPresets(learner: LearnerState): VoicePreset[] {
  const interviews = SCENARIOS.map((s) => interviewPreset(s.id, learner)).filter(
    (p): p is VoicePreset => p !== undefined,
  );
  return [...BUILT_IN_PRESETS, ...interviews];
}
