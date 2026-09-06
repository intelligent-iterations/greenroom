import { JudgeVerdict, applicableRubric, buildJudgePrompt, type Score } from './deps.ts';
import type { EvalBackend } from './backends.ts';

/**
 * LLM-as-judge.
 *
 * Three things make this trustworthy enough to gate a build on, and all three
 * were added after watching the naive version produce confident nonsense:
 *
 *  1. **Temperature 0 and a fixed rubric.** Judgement should be boring.
 *  2. **Mandatory evidence quotes, verified.** A score whose quote does not
 *     appear in the turn is discarded rather than counted. Requiring a quote
 *     constrains the judge to the text in front of it; verifying the quote is
 *     what makes the requirement more than a suggestion, and it converts an
 *     invented justification from a silent wrong score into a visible retry.
 *  3. **Bounded retries on malformed JSON**, then a hard error. Silently
 *     scoring a case as zero because the judge emitted prose would look exactly
 *     like a quality regression and send someone chasing a prompt that was fine.
 */
export interface JudgeResult {
  scores: Score[];
  headline: string;
  /** Scores dropped because their evidence was not in the turn. */
  discarded: number;
}

const MAX_ATTEMPTS = 3;

export async function judgeTurn(
  backend: EvalBackend,
  input: {
    interviewerSystemPrompt: string;
    transcript: string;
    turnUnderTest: string;
    passages?: string[];
  },
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(input);
  // Which dimensions were actually put to the judge. A verdict scoring one that
  // was not asked for is not a bonus: it means the judge is working from its
  // own idea of the rubric, and the score would enter a dimension mean that
  // most cases never populate.
  const asked = new Set(applicableRubric(input.passages).map((d) => d.id));
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const raw = await backend.complete(
      [
        { role: 'system', content: 'You return only valid JSON. No prose, no markdown fences.' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0, maxTokens: 1200 },
    );

    const parsed = JudgeVerdict.safeParse(extractJson(raw));
    if (!parsed.success) {
      lastError = `attempt ${attempt}: ${parsed.error.issues[0]?.message ?? 'unparseable'}`;
      continue;
    }

    const normalised = normaliseHaystack(input.turnUnderTest);
    const kept: Score[] = [];
    let discarded = 0;

    for (const score of parsed.data.scores) {
      if (!asked.has(score.dimension)) {
        discarded += 1;
        continue;
      }
      if (normalised.includes(normaliseHaystack(score.evidence))) kept.push(score);
      else discarded += 1;
    }

    // Dropping most of the verdict means the judge was not really reading the
    // turn. Retry rather than score the case on two surviving numbers — and if
    // retries run out, fail loudly. Returning an empty verdict here would score
    // the case 0 and read as a catastrophic quality regression, sending someone
    // to bisect a prompt that was never the problem.
    if (kept.length < asked.size / 2) {
      lastError = `attempt ${attempt}: ${discarded} of ${parsed.data.scores.length} scores had unverifiable evidence`;
      continue;
    }

    return { scores: kept, headline: parsed.data.headline, discarded };
  }

  throw new Error(`Judge failed after ${MAX_ATTEMPTS} attempts (${lastError})`);
}

/**
 * Loose containment test for evidence quotes.
 *
 * Judges routinely normalise curly quotes, collapse whitespace or drop a
 * trailing comma when quoting. Comparing raw strings rejected quotes that were
 * plainly present, so the comparison is done on a flattened form.
 */
function normaliseHaystack(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
