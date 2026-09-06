export interface CheckResult {
  check: string;
  passed: boolean;
  /** Why it failed, for the report. Empty when passed. */
  detail: string;
  /** A failed critical check fails the build on its own. */
  critical: boolean;
}

import type { InterviewScenario } from './domain.js';

/**
 * Deterministic checks.
 *
 * These run on every turn before the judge and cost nothing. They exist because
 * a meaningful share of real failures are mechanically detectable — markdown in
 * a turn that gets read aloud, three stacked questions, the model announcing it
 * is an AI — and paying a model to notice those is slow, non-deterministic and
 * occasionally wrong about things a regex is never wrong about.
 *
 * Lives in the shared package, not the harness, because the same checks run in
 * two places: offline against a vendor model, and in the browser against the
 * on-device model that actually ships. Two copies would drift, and the copy
 * that drifted would be the one grading the thing users run.
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

/**
 * Assistant-speak. An interviewer never offers to help.
 *
 * This is the register a general-purpose model falls back into when it loses
 * the role, and it is the failure a live test surfaced that every existing
 * check missed: the turns were clean, short, well-formed prose that simply were
 * not an interview.
 */
/**
 * Imperative question forms.
 *
 * Real interviewers ask plenty of things that never contain a question mark —
 * "Walk me through the migration", "Tell me about a time you were wrong",
 * "Describe the failure". Requiring '?' would fail those, and a check that
 * fails good output is worse than no check: it trains people to ignore it.
 */
const IMPERATIVE_ASK = [
  // "tell me about the migration" and "tell me what you built" are the same
  // move; only the first was matched, so two adversarial cases failed on turns
  // that were asking perfectly clearly. The wh-word list keeps it tight — a
  // bare "tell me" also appears in turns that are not asks.
  /\b(?:tell|talk|walk) me (?:about|through|what|how|why|when|where|which|who|if|whether)\b/i,
  /\bdescribe\b/i,
  /\bexplain\b/i,
  /\bgive me an example\b/i,
  /\bstep me through\b/i,
  // French, for the bilingual scenarios. Omitting these failed a correct
  // French opening turn, which is how they came to be here.
  /\b(?:parlez|dites|racontez)-moi\b/i,
  /\b(?:décrivez|expliquez|donnez)-moi?\b/i,
];

/**
 * Turns that legitimately ask nothing.
 *
 * Not every interviewer turn is a question, and treating them all as such was
 * wrong. When a candidate asks what a good answer looks like, or invites a
 * question about a protected characteristic, or asks a scoping question, the
 * correct turn declines or answers briefly and hands the floor back — the
 * question already on the table still stands.
 *
 * Three of the adversarial cases are exactly this, and the first version of
 * `asks_a_question` failed all three. They are the cases most worth getting
 * right, so the check recognises a returned floor rather than being weakened.
 */
const RETURNS_FLOOR = [
  /\bgo ahead\b/i,
  /\banswer it\b/i,
  /\bback to (?:where we were|the question|my question)\b/i,
  /\b(?:let us|let's) stay on\b/i,
  /\b(?:let us|let's) (?:get )?back to\b/i,
  /\bfor now,? (?:tell|walk|describe)\b/i,
  /\brevenons\b/i,
];

const ASSISTANT_VOICE = [
  /\bhow can I (?:help|assist)\b/i,
  /\bI(?:'m| am) here to (?:help|assist)\b/i,
  /\bfeel free to\b/i,
  /\blet me know if\b/i,
  /\bis there anything else\b/i,
  /\bI hope (?:this|that) helps\b/i,
  /\bhappy to help\b/i,
  /\bthanks for sharing\b/i,
  /\bgreat question\b/i,
];

/** Spoken-word ceiling. Past this a turn stops being a question and becomes a speech. */
const MAX_SPOKEN_WORDS = 75;

function check(name: string, passed: boolean, detail: string, critical = false): CheckResult {
  return { check: name, passed, detail: passed ? '' : detail, critical };
}

/**
 * Conversation context, for the checks that cannot be decided from one turn.
 *
 * "Is this turn echoing the candidate?" and "has it asked this already?" are
 * both mechanical, but only against what came before.
 */
export interface CheckContext {
  /** Interviewer turns already spoken this session, oldest first. */
  previousInterviewerTurns?: string[];
  /** What the candidate said immediately before this turn. */
  lastCandidateAnswer?: string;
}

/** Content words, lowercased, for overlap comparisons. */
function contentWords(text: string): Set<string> {
  const stop = new Set([
    'the','a','an','and','or','but','if','of','to','in','on','at','for','with','was','were','is',
    'are','it','that','this','you','your','i','we','they','he','she','my','me','so','as','be','been',
    'had','has','have','do','did','does','what','how','when','why','about','from','there','their',
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stop.has(w)),
  );
}

/** Jaccard overlap of content words, 0..1. */
function overlap(a: string, b: string): number {
  const setA = contentWords(a);
  const setB = contentWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / Math.min(setA.size, setB.size);
}

/** Above this, a turn is restating rather than interviewing. */
const ECHO_THRESHOLD = 0.7;
/** Above this, a turn is asking something already asked. */
const REPEAT_THRESHOLD = 0.8;
/**
 * Below this overlap with a question, an answer did not engage with it.
 *
 * Deliberately low. The cost of setting it too high is failing a build for
 * re-asking a dodged question, which is the interviewer doing its job.
 */
const ENGAGEMENT_FLOOR = 0.2;

export function runChecks(
  turn: string,
  scenario: InterviewScenario,
  context: CheckContext = {},
): CheckResult[] {
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

  // The check that was missing. An interviewer interviews; a turn that asks
  // nothing has stopped doing the job, however well-formed it is. Critical,
  // because a session of statements is not an interview at all.
  //
  // Counts imperative asks and turns that hand the floor back to a question
  // already asked — see IMPERATIVE_ASK and RETURNS_FLOOR.
  const asks =
    questions >= 1 ||
    IMPERATIVE_ASK.some((p) => p.test(text)) ||
    RETURNS_FLOOR.some((p) => p.test(text));
  results.push(
    check('asks_a_question', asks, 'asks nothing and does not return the floor', true),
  );

  const assistant = ASSISTANT_VOICE.filter((p) => p.test(text));
  results.push(
    check('interviewer_register', assistant.length === 0, 'slips into assistant voice', true),
  );

  if (context.lastCandidateAnswer) {
    const echo = overlap(text, context.lastCandidateAnswer);
    results.push(
      check(
        'not_echoing',
        echo < ECHO_THRESHOLD,
        `restates the candidate's own answer (${echo.toFixed(2)} overlap)`,
      ),
    );
  }

  for (const previous of context.previousInterviewerTurns ?? []) {
    const repeat = overlap(text, previous);
    if (repeat < REPEAT_THRESHOLD) continue;
    // Re-asking a question the candidate dodged is correct interviewing, not a
    // repeat. Only a question they actually engaged with is one worth flagging,
    // so the candidate's last answer decides: if it barely touches the earlier
    // question, they never answered it and the interviewer is right to return.
    // Without this the check fires hardest on exactly the behaviour the
    // adversarial derail case exists to reward.
    if (
      context.lastCandidateAnswer !== undefined &&
      overlap(context.lastCandidateAnswer, previous) < ENGAGEMENT_FLOOR
    ) {
      continue;
    }
    results.push(
      check('not_repeating', false, `repeats an earlier question (${repeat.toFixed(2)} overlap)`),
    );
    break;
  }

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
