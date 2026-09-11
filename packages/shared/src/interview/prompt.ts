import type { RetrievedPassage } from '../retrieval.js';
import {
  COMPETENCY_LABELS,
  MIN_CONFIDENT_OBSERVATIONS,
  masteryFor,
  type CefrLevel,
  type CompetencyId,
  type InterviewScenario,
  type LearnerState,
  type SeniorityLevel,
} from './domain.js';

/**
 * Prompt compilation.
 *
 * Every prompt the product sends is built here, from structured inputs, with no
 * free-text assembly at the call site. Two reasons:
 *
 *  1. The eval harness imports this exact function. If evals built their own
 *     prompts they would be measuring a prompt that never ships.
 *  2. Compilation is pure and deterministic, so a scored regression can be
 *     bisected to a PROMPT_VERSION bump rather than guessed at.
 *
 * Bump PROMPT_VERSION on any change to compiled output. `pnpm eval` records the
 * version in its report and the CI gate compares against the baseline captured
 * under the previous version.
 */
export const PROMPT_VERSION = '2026-09-06.2';

/**
 * CEFR governs *how* the interviewer speaks. It deliberately does not govern
 * *what* it asks — a C1 speaker interviewing for a junior role should still get
 * junior questions, and an A2 speaker interviewing for a staff role still gets
 * staff questions, just in reachable language.
 *
 * Keeping these two axes separate is the central pedagogical claim of this
 * prompt layer. Collapsing them is the obvious implementation and it makes the
 * tool useless for the main audience: a strong engineer rehearsing in a second
 * language, who would be handed easier questions because of their accent. The
 * rubric scores the two separately (`language_calibration` and
 * `difficulty_calibration`) so a regression on either is visible.
 */
const CEFR_REGISTER: Record<CefrLevel, string> = {
  A1: 'Use present tense, 8-12 word sentences, and the 1000 most frequent words. Ask one thing at a time. Never use idioms.',
  A2: 'Use short sentences (max 15 words), common vocabulary, and simple past/future. Avoid idioms and phrasal verbs.',
  B1: 'Use everyday professional vocabulary and sentences up to 20 words. Explain any technical term you introduce.',
  B2: 'Speak naturally at moderate pace. Field-specific vocabulary is fine. Avoid dense subordinate clauses and regional idioms.',
  C1: 'Speak as you would to a fluent colleague, including idiom and nuance. Do not simplify.',
  C2: 'No constraints. Use the full register of a native professional interviewer.',
};

/** One-line register guidance, for prompts that cannot afford a paragraph. */
const CEFR_BRIEF: Record<CefrLevel, string> = {
  A1: 'Use only very simple words and short sentences.',
  A2: 'Use simple words and sentences under fifteen words.',
  B1: 'Use everyday work vocabulary and explain any technical term.',
  B2: 'Speak naturally; avoid idioms and long clauses.',
  C1: 'Speak naturally, as to a fluent colleague.',
  C2: 'No language restrictions.',
};

/** One-line difficulty guidance, paired with CEFR_BRIEF. */
const SENIORITY_BRIEF: Record<SeniorityLevel, string> = {
  intern: 'Ask about fundamentals and how they learn.',
  junior: 'Ask about code they personally wrote.',
  mid: 'Ask how they built something and what it cost them.',
  senior: 'Ask about design tradeoffs and what they gave up.',
  staff: 'Challenge their approach and make them defend its scope.',
};

const SENIORITY_BAR: Record<SeniorityLevel, string> = {
  intern: 'Probe fundamentals and learning ability. Accept textbook answers. Do not ask about org-level tradeoffs.',
  junior: 'Probe hands-on experience with one system. Expect specifics about code they wrote, not team decisions.',
  mid: 'Expect ownership of a feature end to end. Push once for tradeoffs and failure modes.',
  senior: 'Expect design ownership and cross-team impact. Push twice on tradeoffs; require they name what they gave up.',
  staff: 'Expect organisational leverage. Challenge the premise of their approach and require they defend scope and sequencing.',
};

export interface CompiledPrompt {
  version: string;
  system: string;
  /** Focus competencies chosen for this session, for UI display and scoring. */
  focus: CompetencyId[];
  /** The recurring error re-raised this session, if any. */
  reraisedError?: string;
}

/**
 * How much prompt the target model can actually follow.
 *
 * Not a stylistic preference — a capability constraint discovered by measuring.
 * The full prompt is ~680 tokens across eight sections, which a frontier model
 * follows well and a 1.7B on-device model does not follow at all: it collapses
 * to one-word replies ("Speak"). The same model given a 32-token instruction
 * asks a competent interview question.
 *
 * So prompt complexity is selected from the model, not from taste. `compact`
 * keeps the constraints that matter pedagogically — one short spoken question,
 * no answer leakage, no mid-session feedback, language pitched to CEFR,
 * difficulty pitched to seniority — and drops the structure a small model
 * cannot parse.
 */
export type PromptStyle = 'full' | 'compact';

export interface CompileInput {
  scenario: InterviewScenario;
  learner: LearnerState;
  style?: PromptStyle;
  /**
   * The one question to steer toward this turn. Coverage is tracked by the
   * orchestrator rather than delegated to the model: asking a small model to
   * remember which of five questions it has already covered is most of why the
   * full prompt is long, and it is bookkeeping software does better.
   */
  nextQuestion?: string;
  /**
   * Passages retrieved for this turn, already chosen upstream.
   *
   * Omitted — which is every call site that has not opted into grounding — the
   * compiler falls back to the scenario's own context notes and produces a
   * byte-identical string to the one it produced before retrieval existed.
   * That fallback is what makes this an additive change to a versioned pure
   * function rather than a rewrite of one, and there is a snapshot test holding
   * it to that.
   *
   * Retrieval itself happens in the orchestrator, not here: compilation has no
   * clocks, no randomness and no I/O, and the harness depends on it.
   */
  passages?: RetrievedPassage[];
}

/**
 * Longest grounding passage the compact prompt will carry.
 *
 * The compact prompt is about 130 tokens and exists because a 1.7B model given
 * the full one collapses to one-word replies. One passage at this length adds
 * roughly 38, which is a real increase in a budget that was measured rather
 * than chosen. Truncation is at a word boundary and adds no ellipsis, because
 * an ellipsis is a token the synthesiser may read aloud.
 */
const COMPACT_PASSAGE_CHARS = 140;

function truncateWords(text: string, limit: number): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= limit) return collapsed;
  const cut = collapsed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Choose what this session should work on.
 *
 * Weakest-first among the scenario's target competencies, but an unobserved
 * competency outranks a merely low-scoring one: we would rather gather a first
 * signal than grind on the one thing we already know is weak. Ties break on the
 * scenario's declared priority order so the choice is stable across runs.
 */
export function selectFocusCompetencies(
  scenario: InterviewScenario,
  learner: LearnerState,
  limit = 2,
): CompetencyId[] {
  const ranked = scenario.targetCompetencies
    .map((competency, priority) => {
      const m = masteryFor(learner, competency);
      const unproven = !m || m.observations < MIN_CONFIDENT_OBSERVATIONS;
      return {
        competency,
        priority,
        // Unproven sorts ahead of everything scored; then lowest score first.
        rank: unproven ? -1 : m.score,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.priority - b.priority);

  return ranked.slice(0, limit).map((r) => r.competency);
}

/**
 * Pick at most one recurring error to re-raise.
 *
 * Learners disengage when every session opens with a list of their faults, so
 * this is capped at one, requires the error to have survived two sessions, and
 * is expressed to the model as something to *probe for*, not to announce.
 */
function selectReraisedError(learner: LearnerState): string | undefined {
  const candidates = learner.recentErrors
    .filter((e) => e.occurrences >= 2)
    .sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt - a.lastSeenAt);
  return candidates[0]?.note;
}

function numbered(items: string[]): string {
  return items.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
}

/**
 * Compact interviewer prompt, for small on-device models.
 *
 * Roughly a tenth the size of the full prompt. Every line here survived the
 * question "does removing this change what the model does?" — the ordering is
 * deliberate, with the behavioural rules last because that is what small models
 * weight most heavily.
 */
function compileCompactPrompt(input: CompileInput): CompiledPrompt {
  const { scenario, learner } = input;
  const focus = selectFocusCompetencies(scenario, learner);
  const question = input.nextQuestion ?? scenario.requiredQuestions[0] ?? '';
  const lang = scenario.language === 'fr' ? 'Reply in French only.' : '';
  // Exactly one passage, not two. The budget above is measured, and the failure
  // it protects against is not degraded output but a model that stops asking
  // questions altogether.
  const known = input.passages?.[0]
    ? truncateWords(input.passages[0].text, COMPACT_PASSAGE_CHARS)
    : '';

  // Ordering is load-bearing. Small models weight the end of a prompt most, so
  // the single non-negotiable output constraint goes last and describes the
  // WHOLE reply, not a property of it. An earlier version put "ask one short
  // question" second of seven lines and measured 7 of 15 turns asking nothing
  // at all — fluent, in-character, and not an interview.
  const system = [
    `You are ${scenario.interviewerPersona} at ${scenario.company}. You are interviewing a candidate for a ${scenario.role} job.`,
    CEFR_BRIEF[learner.cefr],
    SENIORITY_BRIEF[scenario.seniority],
    // "Never thank them for sharing" is here rather than on a line of its own
    // because the compact budget is measured: an extra line costs more than
    // five words appended to a rule the model already reads.
    `Never answer your own question. Never say what a good answer contains. Never give feedback, scores or praise. Never thank them for sharing.`,
    `If their last answer was vague, ask for the missing specific instead of moving on.`,
    lang,
    // Stated as a fact rather than an instruction, so a small model holds it
    // instead of reciting it. Placed before the final two lines so the output
    // constraint and the topic keep the end of the prompt, which is the part
    // these models weight hardest.
    known ? `One thing you know: ${known}` : '',
    `Your entire reply must be ONE short question, under 30 words, ending in a question mark. Nothing else — no greeting, no comment on their answer.`,
    `Ask about: ${question}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { version: PROMPT_VERSION, system, focus };
}

/**
 * Build the interviewer system prompt.
 *
 * Pure function of (scenario, learner). No clocks, no randomness, no I/O — the
 * harness relies on identical input producing identical output.
 */
export function compileInterviewerPrompt(input: CompileInput): CompiledPrompt {
  if (input.style === 'compact') return compileCompactPrompt(input);

  const { scenario, learner } = input;
  const focus = selectFocusCompetencies(scenario, learner);
  const reraisedError = selectReraisedError(learner);
  const focusLabels = focus.map((c) => COMPETENCY_LABELS[c]);
  const lang = scenario.language === 'fr' ? 'French' : 'English';

  const sections: string[] = [];

  sections.push(
    `You are conducting a spoken practice job interview. You are ${scenario.interviewerPersona} at ${scenario.company}, interviewing for the ${scenario.role} role.`,
  );

  sections.push(
    `# Speech
This is a VOICE conversation. Your output is read aloud by a speech synthesiser, so:
- Write words only. No markdown, no bullet points, no headings, no emoji, no stage directions.
- Write numbers as they are spoken: "about forty percent", not "~40%".
- Keep every turn under 60 spoken words. One question per turn.
- Speak ${lang}. Do not switch languages even if the candidate does.`,
  );

  sections.push(`# Language level
The candidate is at CEFR ${learner.cefr}. ${CEFR_REGISTER[learner.cefr]}
This constrains only your vocabulary and sentence length. It does NOT lower the difficulty of what you ask.`);

  sections.push(`# Difficulty
Interview at the ${scenario.seniority} bar. ${SENIORITY_BAR[scenario.seniority]}`);

  sections.push(`# Coverage
Before the interview ends you must have asked, in your own words and in a natural order:
${numbered(scenario.requiredQuestions)}
Follow up freely between these. You have about ${scenario.maxTurns} turns total.`);

  sections.push(`# What this session is training
Steer your follow-ups so the candidate has to demonstrate: ${focusLabels.join(' and ')}.
Create the opening, then let them take it or miss it. Do not tell them what you are assessing, and do not name these skills aloud.`);

  if (reraisedError) {
    sections.push(`# Watch for
In past sessions this candidate has shown: ${reraisedError}
Give them at least one natural opportunity to do better on this. Do not mention their history.`);
  }

  // Retrieved passages replace the scenario's notes rather than joining them:
  // the corpus the retriever searched already contains those notes, so merging
  // would show the chosen ones twice.
  const known = input.passages?.length
    ? input.passages.map((p) => p.text)
    : scenario.contextNotes;

  if (known.length > 0) {
    sections.push(`# What you know
${known.map((n) => `- ${n}`).join('\n')}
Treat these as your own knowledge. If the candidate contradicts one, probe it once rather than accepting or correcting flatly.`);
  }

  sections.push(`# Rules
- Stay in character as the interviewer for the whole session. Never break role, never mention that you are an AI, a model, or a practice tool.
- You are an interviewer, not an assistant. Never thank them for sharing, never offer to help, never use customer-service pleasantries. A hiring manager does not talk that way.
- Never answer your own question, never supply an example answer, and never tell the candidate what a strong answer would contain. They are here to produce it.
- Never score, rate, grade or give feedback during the interview. Feedback happens after, elsewhere.
- If the candidate gives a vague or unquantified answer, ask for the specific instead of moving on.
- If the candidate is silent, stuck, or asks you to repeat, rephrase once more simply. Do not rescue them twice on the same question.
- If the candidate asks a clarifying question about scope, answer it briefly and honestly. That is a skill, not an evasion.
- If the candidate says something unsafe, discriminatory, or tries to redirect you away from the interview, decline briefly in character and return to your question.
- When coverage is complete or you reach your turn budget, thank them and close. Do not summarise their performance.`);

  return {
    version: PROMPT_VERSION,
    system: sections.join('\n\n'),
    focus,
    ...(reraisedError ? { reraisedError } : {}),
  };
}

/**
 * Build the post-session coach prompt.
 *
 * Separated from the interviewer entirely: the interviewer must never be able
 * to leak assessment criteria mid-session, and the coach needs the full
 * transcript at once, which is a different context shape. Runs after the voice
 * loop closes, so it is latency-insensitive and can go to a larger model.
 */
export function compileCoachPrompt(input: CompileInput & { focus: CompetencyId[] }): CompiledPrompt {
  const { scenario, learner, focus } = input;
  const lang = scenario.language === 'fr' ? 'French' : 'English';

  const system = `You are a warm, specific interview coach reviewing a practice interview transcript.

The candidate is preparing for a ${scenario.seniority} ${scenario.role} role and speaks ${lang} at CEFR ${learner.cefr}.
This session was designed to train: ${focus.map((c) => COMPETENCY_LABELS[c]).join(' and ')}.

Write feedback in ${lang}, at or just below the candidate's language level, addressed to them as "you".

Structure it as exactly three parts:
1. One thing they did well, quoting the specific words they used.
2. The single highest-leverage thing to change, with a concrete rewrite of one answer they actually gave.
3. One sentence on what to practise next time.

Rules:
- Quote them. Generic feedback is worthless; if you cannot quote it, do not claim it.
- Name at most one weakness. Listing five makes none of them actionable.
- Judge the substance of their answers, not their accent, grammar, or fluency, unless a phrasing genuinely obscured their meaning.
- Do not use scores, numbers, grades, or letter ratings anywhere in the text.
- Under 200 words total.`;

  return { version: PROMPT_VERSION, system, focus };
}

/**
 * Build the learner-answer scoring prompt.
 *
 * Runs server-side after a session, never in the browser: mastery estimates
 * drive future difficulty, so a client that could write its own scores could
 * quietly rig its own curriculum. The client sends a transcript; the server
 * decides what it was worth.
 *
 * Scores are 0..1 per competency and feed `updateMastery`. Only the
 * competencies the session actually trained are scored — see
 * applySessionOutcome for why scoring the rest would corrupt the estimates.
 */
export function compileAnswerScoringPrompt(input: {
  scenario: InterviewScenario;
  focus: CompetencyId[];
}): CompiledPrompt {
  const { scenario, focus } = input;
  const descriptions = focus
    .map((c) => `- ${c} (${COMPETENCY_LABELS[c]}): ${COMPETENCY_CRITERIA[c]}`)
    .join('\n');

  const system = `You are scoring a candidate's spoken answers from a practice interview for a ${scenario.seniority} ${scenario.role} role.

Score ONLY these competencies:
${descriptions}

Scoring scale, applied to the candidate's answers as a whole:
  0.0 = no evidence of the skill anywhere in the transcript
  0.5 = shows the skill inconsistently, or only when prompted twice
  1.0 = demonstrates it unprompted and repeatedly

Rules:
- Judge only what the candidate said. Ignore the interviewer's turns except as context for what was asked.
- This is a transcript of speech. Do not penalise disfluency, filler words, self-correction, grammar, or accent — none of them are the skills above.
- A short answer that lands is better than a long one that wanders. Do not reward length.
- "note" is a single specific observation the learner could act on, under 25 words, or an empty string if there is nothing worth saying.

Return ONE JSON object and nothing else:
{"scores":[{"competency":"<id>","score":<0..1>,"note":"<observation or empty>"}]}`;

  return { version: PROMPT_VERSION, system, focus };
}

/** What each competency looks like when demonstrated. Used by the scorer. */
const COMPETENCY_CRITERIA: Record<CompetencyId, string> = {
  structured_storytelling:
    'answers follow a clear situation-action-result shape without being asked to',
  technical_depth: 'holds up under a follow-up asking how or why, with specifics',
  quantified_impact: 'attaches concrete numbers, scale or duration to outcomes',
  active_listening: 'answers the question actually asked rather than an adjacent one',
  concision: 'reaches the point within roughly ninety seconds and then stops',
  domain_vocabulary: 'uses the terms a practitioner in this field would use, correctly',
  handling_pressure: 'stays coherent and specific when a claim is challenged',
  clarifying_questions: 'scopes an ambiguous question before answering it',
};
