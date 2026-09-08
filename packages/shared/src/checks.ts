export interface CheckResult {
  check: string;
  passed: boolean;
  /** Why it failed, for the report. Empty when passed. */
  detail: string;
  /** A failed critical check fails the build on its own. */
  critical: boolean;
}


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
  // Same construction as "step me through", found the same way: on a live turn
  // ("Start me from wherever you'd begin") that handed the floor over as
  // clearly as any question mark would have.
  /\bstart me (?:from|at|with|wherever)\b/i,
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
  /** Agent turns already spoken this session, oldest first. */
  previousAgentTurns?: string[];
  /** What the user said immediately before this turn. */
  lastUserTurn?: string;
  /** Retrieved passages put in front of the model for this turn, verbatim. */
  injectedPassages?: string[];
  /** Language the turn is expected to be in, when the caller cares. */
  expectedLanguage?: string;
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

/**
 * Longest run of words a turn may share with a passage it was handed.
 *
 * Grounding is mostly a judgement call and belongs in the rubric, but one
 * failure is exactly decidable and it is the one a small model handed a passage
 * actually exhibits: it reads the passage back at the candidate instead of
 * asking about it.
 *
 * Eight is deliberately generous. An interviewer legitimately quotes a phrase
 * back — "you mentioned the Rails monolith" — and a threshold that fired on
 * that would fail correct behaviour, which is worse than no check because it
 * teaches people to ignore the suite.
 */
const MAX_VERBATIM_RUN = 8;

/** Words in common between two texts, as the longest unbroken run. */
function longestSharedRun(a: string, b: string): number {
  const left = normaliseWords(a);
  const right = normaliseWords(b);
  if (left.length === 0 || right.length === 0) return 0;

  let best = 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = (previous[j - 1] ?? 0) + 1;
        if (current[j]! > best) best = current[j]!;
      }
    }
    previous = current;
  }
  return best;
}

function normaliseWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * A check, as a value.
 *
 * Checks used to be imperative pushes inside one function, which worked while
 * there was one kind of agent. It stopped working the moment the answer to
 * "which checks apply?" became "it depends what you are building": a support
 * bot must not be failed for answering rather than asking, and an interviewer
 * must not be let off for giving away the answer.
 *
 * So a check is a value, packs are arrays of them, and the caller composes.
 * `run` returns undefined to stay silent — for a check that needs context this
 * turn did not carry, which is different from passing.
 */
export interface Check {
  name: string;
  critical: boolean;
  run(turn: string, context: CheckContext): { passed: boolean; detail: string } | undefined;
}

/**
 * Checks that apply to any agent whose output is read aloud.
 *
 * Nothing here assumes what the agent is for. These are the properties of
 * speech itself — that it can be synthesised, that it is short enough to hold,
 * that it is in the expected language, that it is not parroting.
 */
export const SPOKEN_CHECKS: Check[] = [
  {
    name: 'non_empty',
    critical: true,
    run: (turn) => ({ passed: turn.length > 0, detail: 'the model produced no turn' }),
  },
  {
    name: 'speakable',
    critical: true,
    run: (turn) => {
      const found = UNSPEAKABLE.filter((u) => u.pattern.test(turn)).map((u) => u.label);
      return { passed: found.length === 0, detail: `contains ${found.join(', ')}` };
    },
  },
  {
    name: 'length',
    critical: false,
    run: (turn) => {
      const words = turn.split(/\s+/).length;
      return {
        passed: words <= MAX_SPOKEN_WORDS,
        detail: `${words} words, over the ${MAX_SPOKEN_WORDS} limit`,
      };
    },
  },
  {
    name: 'single_question',
    critical: false,
    run: (turn) => {
      const questions = (turn.match(/\?/g) ?? []).length;
      return { passed: questions <= 1, detail: `asks ${questions} questions in one turn` };
    },
  },
  {
    name: 'language',
    critical: true,
    // Only meaningful when the caller says what was expected. A whole turn in
    // the wrong language is a total failure that a composite score would
    // otherwise dilute across nine dimensions.
    run: (turn, ctx) => {
      if (ctx.expectedLanguage !== 'fr') return undefined;
      return { passed: looksFrench(turn), detail: 'expected French, got something else' };
    },
  },
  {
    name: 'not_echoing',
    critical: false,
    run: (turn, ctx) => {
      if (ctx.lastUserTurn === undefined) return undefined;
      const echo = overlap(turn, ctx.lastUserTurn);
      return {
        passed: echo < ECHO_THRESHOLD,
        detail: `restates the user's own words (${echo.toFixed(2)} overlap)`,
      };
    },
  },
  {
    name: 'not_repeating',
    critical: false,
    run: (turn, ctx) => {
      for (const previous of ctx.previousAgentTurns ?? []) {
        if (overlap(turn, previous) < REPEAT_THRESHOLD) continue;
        // Re-asking something the user dodged is doing the job, not repeating.
        // Only something they actually engaged with is worth flagging, so their
        // last turn decides: if it barely touches the earlier one, they never
        // answered it. Without this the check fires hardest on exactly the
        // behaviour an adversarial derail case exists to reward.
        if (
          ctx.lastUserTurn !== undefined &&
          overlap(ctx.lastUserTurn, previous) < ENGAGEMENT_FLOOR
        ) {
          continue;
        }
        return {
          passed: false,
          detail: `repeats an earlier turn (${overlap(turn, previous).toFixed(2)} overlap)`,
        };
      }
      return undefined;
    },
  },
  {
    name: 'not_reciting_context',
    critical: false,
    run: (turn, ctx) => {
      for (const passage of ctx.injectedPassages ?? []) {
        const run = longestSharedRun(turn, passage);
        if (run <= MAX_VERBATIM_RUN) continue;
        return { passed: false, detail: `reads ${run} words of its own context back at the user` };
      }
      return undefined;
    },
  },
];

/**
 * For an agent playing a character rather than being an assistant.
 *
 * Separate from SPOKEN_CHECKS because plenty of voice agents are *supposed* to
 * sound like a helpful assistant, and failing those for saying "happy to help"
 * would be the check being wrong rather than the agent.
 */
export const IN_CHARACTER_CHECKS: Check[] = [
  {
    name: 'in_character',
    critical: true,
    run: (turn) => ({
      passed: !ROLE_BREAKS.some((p) => p.test(turn)),
      detail: 'breaks character',
    }),
  },
  {
    name: 'no_assistant_voice',
    critical: true,
    run: (turn) => ({
      passed: !ASSISTANT_VOICE.some((p) => p.test(turn)),
      detail: 'slips into assistant voice',
    }),
  },
];

/**
 * For an agent that must hand the floor back every turn.
 *
 * An interviewer, a tutor, a survey bot. Not a support agent answering a
 * question, which is why this is opt-in: a turn that asks nothing is correct
 * behaviour for some agents and a broken session for others.
 */
export const TURN_TAKING_CHECKS: Check[] = [
  {
    name: 'asks_a_question',
    critical: true,
    run: (turn) => {
      const asks =
        (turn.match(/\?/g) ?? []).length >= 1 ||
        IMPERATIVE_ASK.some((p) => p.test(turn)) ||
        RETURNS_FLOOR.some((p) => p.test(turn));
      return { passed: asks, detail: 'asks nothing and does not return the floor' };
    },
  },
];

/**
 * For an agent whose job is to make someone else produce the answer.
 *
 * A coach, an interviewer, a tutor, an examiner. Giving away the answer or
 * grading mid-session defeats the exercise; for an agent that is meant to
 * explain things, both are the point.
 */
export const COACHING_CHECKS: Check[] = [
  {
    name: 'no_answer_leakage',
    critical: true,
    run: (turn) => {
      const leaks = LEAKAGE.filter((p) => p.test(turn));
      return { passed: leaks.length === 0, detail: `matched ${leaks.length} leakage pattern(s)` };
    },
  },
  {
    name: 'no_mid_session_feedback',
    critical: false,
    run: (turn) => ({
      passed: !MID_SESSION_FEEDBACK.some((p) => p.test(turn)),
      detail: 'grades the user mid-session',
    }),
  },
];

/** Everything, for an agent that is all of the above. */
export const ALL_CHECKS: Check[] = [
  ...SPOKEN_CHECKS,
  ...IN_CHARACTER_CHECKS,
  ...TURN_TAKING_CHECKS,
  ...COACHING_CHECKS,
];

/**
 * Run a set of checks against one turn.
 *
 * `non_empty` short-circuits: every other check would report nonsense about an
 * empty string, and a list of eleven failures for one cause is a worse report
 * than one failure.
 */
export function runChecks(
  turn: string,
  context: CheckContext = {},
  checks: Check[] = ALL_CHECKS,
): CheckResult[] {
  const text = turn.trim();
  const results: CheckResult[] = [];

  for (const spec of checks) {
    const outcome = spec.run(text, context);
    if (outcome === undefined) continue;
    results.push(check(spec.name, outcome.passed, outcome.detail, spec.critical));
    if (spec.name === 'non_empty' && !outcome.passed) return results;
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
