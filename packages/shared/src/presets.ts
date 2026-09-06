import { z } from 'zod';
import { compileInterviewerPrompt, type PromptStyle } from './prompt.js';
import { SCENARIOS } from './scenarios.js';
import type { InterviewLanguage, LearnerState } from './domain.js';

/**
 * A conversational partner the voice loop can run.
 *
 * The pipeline was built around one use case — a job interviewer — and the
 * interesting part turned out to be the pipeline, not the interview. A preset
 * is the seam that separates them: the orchestrator sequences audio and turns,
 * and a preset says who is on the other end.
 *
 * Everything a preset carries is what a small on-device model needs to hold a
 * role: a system prompt, an opening move, a turn budget, and a voice. The
 * interview lives on as one preset among several, built by the same prompt
 * compiler as before, so its pedagogy is not lost to the generalisation.
 */
export const VoicePreset = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** One line, shown in the picker. */
  description: z.string().min(1),
  language: z.enum(['en', 'fr']),
  /** The system prompt, already compiled. */
  systemPrompt: z.string().min(1),
  /**
   * Seeded first user message.
   *
   * Small models answer a bare system prompt with a single word — measured, not
   * assumed. Giving them something to respond to is the difference between an
   * opening question and "Speak". Never shown to the user.
   */
  openingMessage: z.string().default("Hello, I'm ready."),
  /** Turns before the session closes. */
  maxTurns: z.number().int().min(1).max(60).default(12),
  /** Kokoro voice id, when the neural voice is in use. */
  voice: z.string().optional(),
  /** Free-text presets are editable; built-in ones are not. */
  editable: z.boolean().default(false),
});
export type VoicePreset = z.infer<typeof VoicePreset>;

/**
 * Prompts written for a ~1.5B on-device model.
 *
 * Deliberately short and end-weighted. A 680-token instruction block collapses
 * these models into one-word replies; the hard output constraint goes last
 * because that is the part they weight most. See PromptStyle in prompt.ts.
 */
function partner(
  id: string,
  title: string,
  description: string,
  lines: string[],
  extra: Partial<VoicePreset> = {},
): VoicePreset {
  return VoicePreset.parse({
    id,
    title,
    description,
    language: 'en',
    systemPrompt: lines.join('\n'),
    ...extra,
  });
}

export const BUILT_IN_PRESETS: VoicePreset[] = [
  partner(
    'chat',
    'Open conversation',
    'A plain spoken conversation. The simplest way to hear what a model sounds like.',
    [
      'You are a warm, curious person having a spoken conversation.',
      'Never use lists, markdown, or symbols — everything you say is read aloud.',
      'Ask about the other person rather than talking about yourself.',
      'Your entire reply must be under 40 spoken words. Say one thing, then stop.',
    ],
  ),
  partner(
    'language-tutor',
    'Language practice',
    'A patient tutor who keeps you talking and corrects one thing at a time.',
    [
      'You are a patient language tutor having a spoken conversation with a learner.',
      'Keep them talking. Ask a follow-up about whatever they just said.',
      'If they made one clear mistake, correct it briefly and move on. Never list mistakes.',
      'Use simple, everyday words and short sentences.',
      'Your entire reply must be under 35 spoken words, ending with a question.',
    ],
  ),
  partner(
    'support-roleplay',
    'Difficult customer',
    'An unhappy customer to practise service calls against.',
    [
      'You are a customer who is annoyed about a late delivery, on the phone with support.',
      'Stay in character. Never break role or mention being an AI.',
      'Be difficult but reasonable — if they handle you well, soften.',
      'Never use lists or symbols; this is spoken aloud.',
      'Your entire reply must be under 40 spoken words.',
    ],
  ),
  partner(
    'rubber-duck',
    'Think out loud',
    'Asks the next obvious question while you talk a problem through.',
    [
      'You are helping someone think out loud about a problem, by asking questions.',
      'Never propose a solution. Ask the next obvious question instead.',
      'If they are vague, ask which specific part they mean.',
      'Never use lists or symbols; this is spoken aloud.',
      'Your entire reply must be ONE short question, under 25 words.',
    ],
  ),
];

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
  });
}

/** A preset from a system prompt the user wrote. */
export function customPreset(systemPrompt: string, language: 'en' | 'fr' = 'en'): VoicePreset {
  return VoicePreset.parse({
    id: 'custom',
    title: 'Your own prompt',
    description: 'Whatever you wrote below.',
    language,
    systemPrompt: systemPrompt.trim() || 'You are a helpful spoken conversation partner.',
    editable: true,
  });
}

export function allPresets(learner: LearnerState): VoicePreset[] {
  const interviews = SCENARIOS.map((s) => interviewPreset(s.id, learner)).filter(
    (p): p is VoicePreset => p !== undefined,
  );
  return [...BUILT_IN_PRESETS, ...interviews];
}
