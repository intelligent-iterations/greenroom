/**
 * Runs the evaluation set against the model that actually ships.
 *
 * The offline harness scores vendor models over HTTP. It cannot reach the
 * on-device model, which is the one learners use — so the suite was grading
 * something the product does not run. This closes that gap: the same cases, the
 * same deterministic checks from @greenroom/shared, executed in the browser
 * against SmolLM2 on WebGPU with the same compact prompt the session compiles.
 *
 * It also compares prompt styles, because the question that prompted this work —
 * "does it stay in the interviewer role?" — is a question about the prompt at
 * least as much as about the model.
 *
 * Results are persisted to localStorage on completion and can be read back
 * with `?view=1` without re-running. A run costs minutes of GPU time, so losing
 * it to a page reload or a lost debugger connection is not acceptable — and it
 * happened, which is why this exists.
 *
 * Query params:
 *   ?style=compact|full|both   (default: both)
 *   ?model=<hf repo>           (default: the manifest's LLM)
 *   ?limit=N                   (default: all cases)
 *   ?view=1                    show the last saved run, do not re-run
 */
const STORAGE_KEY = 'greenroom.evals.last';
import {
  compileInterviewerPrompt,
  findScenario,
  runChecks,
  type CheckResult,
  type LearnerState,
  type PromptStyle,
} from '@greenroom/shared';
import { InferencePipeline } from '../voice/pipeline-worker.js';

interface Case {
  id: string;
  scenario: string;
  probes: string;
  learner?: Partial<Pick<LearnerState, 'cefr' | 'seniority'>>;
  transcript?: { role: 'interviewer' | 'learner'; text: string }[];
  tags?: string[];
}

interface CaseOutcome {
  id: string;
  style: PromptStyle;
  turn: string;
  failures: string[];
  criticalFailures: string[];
  ms: number;
}

const out = document.getElementById('out')!;
const state: Record<string, unknown> = { stage: 'loading' };

/**
 * Mirrors state to the local collector as the run proceeds.
 *
 * Progress, not just the final result: reading a long GPU run through a browser
 * debugger proved unreliable enough to lose two completed runs, and a run that
 * silently stops needs to be distinguishable from one that is merely slow.
 * Best-effort, so no collector is not a failure.
 */
let lastReport = 0;
function report(force = false): void {
  const now = performance.now();
  if (!force && now - lastReport < 3000) return;
  lastReport = now;
  void fetch('http://localhost:5185/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  }).catch(() => {});
}

const show = () => {
  out.textContent = JSON.stringify(state, null, 2);
  report();
};
show();

const BASE_LEARNER: LearnerState = {
  userId: 'eval', cefr: 'B2', seniority: 'mid', language: 'en',
  targetRole: 'Backend Engineer', mastery: [], recentErrors: [],
  sessionsCompleted: 5, updatedAt: 0, documents: [],
};

async function loadCases(): Promise<Case[]> {
  const files = ['interviewer-core.jsonl', 'interviewer-adversarial.jsonl'];
  const cases: Case[] = [];
  for (const file of files) {
    const text = await (await fetch(`/evals/${file}`)).text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) cases.push(JSON.parse(trimmed) as Case);
    }
  }
  return cases;
}

async function main() {
  const params = new URLSearchParams(location.search);

  if (params.get('view')) {
    const saved = localStorage.getItem(STORAGE_KEY);
    // Copied key by key rather than Object.assign'd from parsed JSON. A stored
    // value containing __proto__ would otherwise reach the prototype chain —
    // the file is written by this page, but it is attacker-controllable by
    // anyone who can run script on this origin, and the safe version costs
    // nothing.
    const parsed: unknown = saved ? JSON.parse(saved) : { stage: 'no saved run' };
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        state[key] = value;
      }
    }
    show();
    return;
  }

  const styles: PromptStyle[] =
    params.get('style') === 'compact' ? ['compact']
    : params.get('style') === 'full' ? ['full']
    : ['compact', 'full'];

  let cases = await loadCases();
  const limit = Number(params.get('limit') ?? 0);
  if (limit > 0) cases = cases.slice(0, limit);
  state.caseCount = cases.length;
  state.styles = styles;
  show();

  // Model is selectable so two candidates can be compared on identical cases —
  // the only way to answer "is the bigger one actually better" with a number.
  const modelRepo = params.get('model') ?? undefined;
  state.model = modelRepo ?? '(manifest default)';
  const pipeline = new InferencePipeline('en', modelRepo);
  await pipeline.load((p) => {
    state.stage = `loading ${p.stage} ${(p.progress * 100).toFixed(0)}%`;
    show();
  });
  state.stage = 'running';
  show();

  const outcomes: CaseOutcome[] = [];

  for (const style of styles) {
    for (const testCase of cases) {
      const scenario = findScenario(testCase.scenario);
      if (!scenario) continue;

      const learner: LearnerState = {
        ...BASE_LEARNER,
        seniority: scenario.seniority,
        language: scenario.language,
        ...testCase.learner,
      };

      // Steer to the first required question the transcript has not already
      // covered, mirroring the orchestrator. Always passing requiredQuestions[0]
      // told the model to ask something the case had already asked, and then
      // scored it as a repeat — the harness manufacturing its own failures.
      const asked = (testCase.transcript ?? [])
        .filter((t) => t.role === 'interviewer')
        .map((t) => t.text.toLowerCase());
      const nextQuestion =
        scenario.requiredQuestions.find(
          (q) => !asked.some((a) => a.includes(q.toLowerCase().slice(0, 25))),
        ) ?? scenario.requiredQuestions[0];

      const prompt = compileInterviewerPrompt({
        scenario,
        learner,
        style,
        ...(nextQuestion ? { nextQuestion } : {}),
      });

      const history = (testCase.transcript ?? []).map((t) => ({
        role: t.role === 'interviewer' ? ('assistant' as const) : ('user' as const),
        content: t.text,
      }));
      if (history.length === 0) history.push({ role: 'user', content: "I'm ready to begin." });

      const started = performance.now();
      let turn = '';
      for await (const delta of pipeline.model.generate(
        [{ role: 'system', content: prompt.system }, ...history],
        { maxTokens: 120 },
      )) {
        turn += delta;
      }
      const ms = Math.round(performance.now() - started);

      const lastCandidate = [...(testCase.transcript ?? [])]
        .reverse()
        .find((t) => t.role === 'learner')?.text;
      const previousInterviewer = (testCase.transcript ?? [])
        .filter((t) => t.role === 'interviewer')
        .map((t) => t.text);

      const checks: CheckResult[] = runChecks(turn.trim(), scenario, {
        ...(lastCandidate ? { lastCandidateAnswer: lastCandidate } : {}),
        previousInterviewerTurns: previousInterviewer,
      });

      outcomes.push({
        id: testCase.id,
        style,
        turn: turn.trim(),
        failures: checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.detail}`),
        criticalFailures: checks.filter((c) => !c.passed && c.critical).map((c) => c.check),
        ms,
      });

      state.progress = `${outcomes.length}/${cases.length * styles.length}`;
      show();
    }
  }

  // Aggregate per style: what a reader actually needs to decide anything.
  const summary: Record<string, unknown> = {};
  for (const style of styles) {
    const forStyle = outcomes.filter((o) => o.style === style);
    const clean = forStyle.filter((o) => o.failures.length === 0);
    const byCheck: Record<string, number> = {};
    for (const outcome of forStyle) {
      for (const failure of outcome.failures) {
        const name = failure.split(':')[0]!;
        byCheck[name] = (byCheck[name] ?? 0) + 1;
      }
    }
    summary[style] = {
      cases: forStyle.length,
      cleanPassRate: +(clean.length / forStyle.length).toFixed(2),
      criticalFailures: forStyle.filter((o) => o.criticalFailures.length > 0).length,
      failuresByCheck: byCheck,
      medianMs: forStyle.map((o) => o.ms).sort((a, b) => a - b)[Math.floor(forStyle.length / 2)],
    };
  }

  state.summary = summary;
  state.worst = outcomes.filter((o) => o.failures.length > 0).slice(0, 12);
  state.stage = 'done';
  state.finishedAt = new Date().toISOString();
  const payload = JSON.stringify({ ...state, outcomes });
  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // Quota. The run is still on screen and on window.__EVALS__.
  }
  // Also push to the local collector so a completed run survives losing the
  // page. Best-effort: no collector running is not a failure.
  void fetch('http://localhost:5185/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).catch(() => {});
  report(true);
  show();
  (window as unknown as { __EVALS__: unknown }).__EVALS__ = { outcomes, summary };
}

main().catch((e) => {
  state.stage = 'error';
  state.error = `${e.name}: ${e.message}`;
  state.stack = String(e.stack ?? '').slice(0, 600);
  report(true);
  show();
});
