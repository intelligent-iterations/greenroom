import {
  CompetencyId,
  compileAnswerScoringPrompt,
  updateMastery,
  type CompetencyMastery,
  type InterviewScenario,
  type LearnerState,
  type ObservedError,
  type Turn,
} from '@greenroom/shared';
import { z } from 'zod';
import { defaultScoringProvider } from './providers/index.js';

const ScoreResponse = z.object({
  scores: z
    .array(
      z.object({
        competency: CompetencyId,
        score: z.number().min(0).max(1),
        note: z.string().max(200).default(''),
      }),
    )
    .max(8),
});

export type AnswerScores = z.infer<typeof ScoreResponse>['scores'];

/**
 * Scores a finished session's learner answers.
 *
 * Server-side and non-negotiable: mastery drives what the learner is asked next,
 * so a client that could post its own scores could quietly choose its own
 * difficulty. The client sends the transcript; the server decides what it meant.
 */
export async function scoreSession(
  scenario: InterviewScenario,
  focus: CompetencyId[],
  turns: Turn[],
): Promise<AnswerScores> {
  const provider = defaultScoringProvider();
  if (!provider) {
    // No cloud provider configured. Mastery simply does not move, which is the
    // right failure: a fabricated score is worse than a missing one.
    console.warn('scoreSession skipped: no configured provider');
    return [];
  }

  const prompt = compileAnswerScoringPrompt({ scenario, focus });
  const transcript = turns
    .filter((t) => t.role !== 'system')
    .map((t) => `${t.role === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
    .join('\n');

  let raw = '';
  for await (const delta of provider.stream({
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: transcript },
    ],
    temperature: 0,
    maxTokens: 600,
    signal: AbortSignal.timeout(30_000),
  })) {
    raw += delta;
  }

  const parsed = ScoreResponse.safeParse(extractJson(raw));
  if (!parsed.success) {
    console.error('scoreSession could not parse model output', { raw: raw.slice(0, 500) });
    return [];
  }

  // The model is asked for the focus competencies only, but asking is not
  // enforcing: anything outside the set would corrupt an estimate the session
  // never actually probed.
  return parsed.data.scores.filter((s) => focus.includes(s.competency));
}

/**
 * Pulls the first JSON object out of a model response.
 *
 * Models wrap JSON in prose or a markdown fence often enough that a bare
 * JSON.parse throws away perfectly good output. Scanning for the outermost
 * braces recovers it.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Folds new scores into a learner's state.
 *
 * Kept pure and exported so it can be tested without Firestore — the update
 * rules (which competencies move, how errors age out) are the part with actual
 * logic in them.
 */
export function foldScores(
  state: LearnerState,
  scores: AnswerScores,
  now: number,
): LearnerState {
  const mastery: CompetencyMastery[] = [...state.mastery];

  for (const { competency, score } of scores) {
    const index = mastery.findIndex((m) => m.competency === competency);
    const updated = updateMastery(competency, mastery[index], score, now);
    if (index >= 0) mastery[index] = updated;
    else mastery.push(updated);
  }

  return {
    ...state,
    mastery,
    recentErrors: mergeErrors(state.recentErrors, scores, now),
    sessionsCompleted: state.sessionsCompleted + 1,
    updatedAt: now,
  };
}

/** Weak performance with a usable note becomes a tracked error. */
const ERROR_SCORE_THRESHOLD = 0.5;
/** Errors not seen for this long stop being re-raised. */
const ERROR_TTL_MS = 1000 * 60 * 60 * 24 * 60;

function mergeErrors(existing: ObservedError[], scores: AnswerScores, now: number): ObservedError[] {
  const merged = existing.filter((e) => now - e.lastSeenAt < ERROR_TTL_MS);

  for (const { competency, score, note } of scores) {
    if (score >= ERROR_SCORE_THRESHOLD || !note) continue;

    const found = merged.find((e) => e.competency === competency);
    if (found) {
      // Occurrences drive whether the prompt layer re-raises it, so a repeat of
      // the same weakness counts even when the wording of the note changes.
      found.occurrences += 1;
      found.note = note;
      found.lastSeenAt = now;
    } else {
      merged.push({ competency, note, occurrences: 1, lastSeenAt: now });
    }
  }

  // Newest first, capped: LearnerState allows at most ten.
  return merged.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 10);
}
