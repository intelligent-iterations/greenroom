import type { CheckResult } from './types.ts';
import type { InterviewScenario } from './deps.ts';

/**
 * Deterministic checks.
 *
 * These run on every turn before the judge and cost nothing. They exist because
 * a meaningful share of real failures are mechanically detectable — markdown in
 * a turn that gets read aloud, three stacked questions, the model announcing it
 * is an AI — and paying a model to notice those is slow, non-deterministic and
 * occasionally wrong about things a regex is never wrong about.
 *
 * The division of labour is strict: anything decidable by a rule lives here,
 * and the judge is reserved for genuine judgement (was the difficulty right,
 * was the follow-up the right one). Every check is written to be
 * high-precision — a false positive here fails a build, so a check that is
 * merely usually right does not belong.
 */

/** Markdown, bullets, emoji, and symbols a synthesiser reads wrong or skips. */
const UNSPEAKABLE = [
  { pattern: /[*_`#]{1,}/, label: 'markdown formatting' },
  { pattern: /^\s*[-•]\s+/m, label: 'bullet list' },
  { pattern: /^\s*\d+\.\s+/m, label: 'numbered list' },
  { pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, label: 'emoji' },
  { pattern: /\d\s*%/, label: 'percent sign (should be written as a word)' },
  { pattern: /[~<>≤≥]/, label: 'mathematical symbol' },
];

/**
 * Phrases that give the answer away.
 *
 * Tuned for precision over recall: each one is a construction that only appears
 * when the model is about to supply content the candidate is supposed to
 * produce. Softer hints are left to the judge's `answer_leakage` dimension,
 * because a rule that tried to catch them would fire on legitimate questions.
 */
const LEAKAGE = [
  /\ba (?:strong|good|great) answer (?:would|should|might)\b/i,
  /\byou (?:could|should|might) (?:say|mention|talk about|highlight)\b/i,
  /\bfor example,? you\b/i,
  /\bwhat I(?:'m| am) looking for (?:here )?is\b/i,
  /\bthe ideal (?:answer|response)\b/i,
  /\bmake sure to (?:mention|include|cover)\b/i,
];

/** Constructions that break the interviewer persona outright. */
const ROLE_BREAKS = [
  /\bas an? (?:AI|artificial intelligence|language model|assistant)\b/i,
  /\bI(?:'m| am) (?:an? )?(?:AI|language model|chatbot|bot)\b/i,
  /\bmy (?:instructions|system prompt|guidelines) (?:say|are)\b/i,
  /\b(?:this is a )?practice (?:interview )?(?:tool|session|simulation)\b/i,
  /\bI cannot (?:actually )?(?:hire|evaluate) you\b/i,
];

/** Assessment language that must not appear until the debrief. */
const MID_SESSION_FEEDBACK = [
  /\b(?:that was a |that's a )?(?:great|excellent|poor|weak) answer\b/i,
  /\bI(?:'d| would) (?:rate|score) (?:that|you)\b/i,
  /\bout of (?:five|ten|5|10)\b/i,
];

/** Spoken-word ceiling. Past this a turn stops being a question and becomes a speech. */
const MAX_SPOKEN_WORDS = 75;

function check(name: string, passed: boolean, detail: string, critical = false): CheckResult {
  return { check: name, passed, detail: passed ? '' : detail, critical };
}

export function runChecks(turn: string, scenario: InterviewScenario): CheckResult[] {
  const results: CheckResult[] = [];
  const text = turn.trim();

  results.push(check('non_empty', text.length > 0, 'the model produced no turn', true));
  if (text.length === 0) return results;

  const unspeakable = UNSPEAKABLE.filter((u) => u.pattern.test(text)).map((u) => u.label);
  results.push(
    check('speakable', unspeakable.length === 0, `contains ${unspeakable.join(', ')}`, true),
  );

  const words = text.split(/\s+/).length;
  results.push(
    check('length', words <= MAX_SPOKEN_WORDS, `${words} words, over the ${MAX_SPOKEN_WORDS} limit`),
  );

  const questions = (text.match(/\?/g) ?? []).length;
  results.push(
    check('single_question', questions <= 1, `asks ${questions} questions in one turn`),
  );

  const leaks = LEAKAGE.filter((p) => p.test(text));
  results.push(
    check('no_answer_leakage', leaks.length === 0, `matched ${leaks.length} leakage pattern(s)`, true),
  );

  const breaks = ROLE_BREAKS.filter((p) => p.test(text));
  results.push(check('in_character', breaks.length === 0, 'breaks the interviewer role', true));

  const feedback = MID_SESSION_FEEDBACK.filter((p) => p.test(text));
  results.push(
    check('no_mid_session_feedback', feedback.length === 0, 'grades the candidate mid-interview'),
  );

  // A French scenario answered in English is a total failure that the composite
  // score would otherwise dilute across eight dimensions.
  if (scenario.language === 'fr') {
    results.push(
      check('language', looksFrench(text), 'expected French, got something else', true),
    );
  }

  return results;
}

/**
 * Cheap language identification.
 *
 * Not a language detector — just enough to catch a whole turn produced in the
 * wrong language, which is the only failure mode this needs to see. Function
 * words are used because they survive any topic.
 */
function looksFrench(text: string): boolean {
  const french = /\b(?:vous|votre|est|une|dans|pour|avec|que|qui|comment|parlez|pouvez)\b/gi;
  const english = /\b(?:you|your|the|and|with|what|how|tell|about|would|could)\b/gi;
  const fr = (text.match(french) ?? []).length;
  const en = (text.match(english) ?? []).length;
  return fr > en;
}

export function checkFailures(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => !r.passed);
}

export function criticalCheckFailures(results: CheckResult[]): CheckResult[] {
  return results.filter((r) => !r.passed && r.critical);
}
