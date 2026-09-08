import {
  AGENT_INSTRUCTIONS,
  parseEvalCsv,
  parseTranscript,
  resultsToCsv,
  runChecks,
  type EvalCsvResultRow,
  type EvalCsvRow,
} from '@greenroom/shared';
import {
  SCENARIOS,
} from '@greenroom/shared/interview';
import { useRef, useState } from 'react';
import { useAppStore } from '../state/store.js';

/**
 * Run your own evaluation cases against the model on this machine.
 *
 * The harness in `evals/` is for someone who clones the repo. This is for
 * someone who wants to know whether a model holds a role and has a
 * spreadsheet — which is most people evaluating on-device models, and none of
 * them want a build step for it.
 *
 * Scored by the same deterministic checks the product uses, so a number here
 * means the same thing as a number in CI.
 */
type Phase = 'idle' | 'loading' | 'running' | 'done' | 'error';

export function EvalsScreen({ onExit }: { onExit: () => void }) {
  const { modelId, customModelRepo, localModelFiles } = useAppStore();
  const [rows, setRows] = useState<EvalCsvRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [results, setResults] = useState<EvalCsvResultRow[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState('');
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const scenario = SCENARIOS[0]!; // checks need a scenario only for its language

  async function run() {
    setPhase('loading');
    setResults([]);
    try {
      const { InferencePipeline } = await import('../voice/pipeline-worker.js');
      const pipeline = new InferencePipeline(
        'en',
        customModelRepo ?? modelId,
        localModelFiles,
      );
      await pipeline.load((p) => setProgress(`${p.stage} ${(p.progress * 100).toFixed(0)}%`));

      setPhase('running');
      const collected: EvalCsvResultRow[] = [];

      for (const [index, row] of rows.entries()) {
        setProgress(`${index + 1} of ${rows.length}`);

        const history = parseTranscript(row.transcript);
        // Small models answer a bare system prompt with one word; give them
        // something to respond to when the case has no transcript.
        if (history.length === 0) history.push({ role: 'user', content: "Hello, I'm ready." });

        const started = performance.now();
        let turn = '';
        for await (const delta of pipeline.model.generate(
          [{ role: 'system', content: row.systemPrompt }, ...history],
          { maxTokens: 120 },
        )) {
          turn += delta;
        }

        const lastUser = [...history].reverse().find((t) => t.role === 'user')?.content;
        const previousAssistant = history.filter((t) => t.role === 'assistant').map((t) => t.content);

        const checks = runChecks(turn.trim(), {
          ...(lastUser ? { lastUserTurn: lastUser } : {}),
          previousAgentTurns: previousAssistant,
        });

        collected.push({
          ...row,
          turn: turn.trim(),
          failures: checks.filter((c) => !c.passed),
          ms: Math.round(performance.now() - started),
        });
        setResults([...collected]);
      }

      await pipeline.dispose();
      setPhase('done');
    } catch (err) {
      setProgress(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  const passed = results.filter((r) => r.failures.length === 0).length;

  return (
    <div className="stack">
      <section className="card">
        <h2>Run your own evaluations</h2>
        <p className="muted">
          Upload a CSV of cases and score them against the model running on this
          machine. Nothing is uploaded anywhere — the models and the scoring both run
          here.
        </p>

        <div className="row">
          <button type="button" className="primary small-btn" onClick={() => fileInput.current?.click()}>
            Choose a CSV
          </button>
          <button
            type="button"
            className="link"
            onClick={async () => {
              await navigator.clipboard.writeText(AGENT_INSTRUCTIONS).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            }}
          >
            {copied ? 'Copied' : 'Copy instructions for an AI to write one'}
          </button>
          <button type="button" className="link" onClick={onExit}>
            Back
          </button>
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const { rows: parsed, errors } = parseEvalCsv(await file.text());
            setRows(parsed);
            setParseErrors(errors);
            setResults([]);
            setPhase('idle');
          }}
        />

        <p className="muted small">
          Columns: <code>id, systemPrompt, transcript, probes</code>. Paste those
          instructions into any assistant and it will produce a file in the right shape.
        </p>

        {parseErrors.length > 0 && (
          <div className="error small">
            {parseErrors.slice(0, 6).map((e) => (
              <div key={e}>{e}</div>
            ))}
            {parseErrors.length > 6 && <div>…and {parseErrors.length - 6} more.</div>}
          </div>
        )}

        {rows.length > 0 && (
          <div className="row" style={{ marginTop: '0.8rem' }}>
            <button
              type="button"
              className="primary small-btn"
              disabled={phase === 'loading' || phase === 'running'}
              onClick={() => void run()}
            >
              {phase === 'loading' || phase === 'running' ? 'Running…' : `Run ${rows.length} case(s)`}
            </button>
            {progress && <span className="muted small">{progress}</span>}
          </div>
        )}
      </section>

      {results.length > 0 && (
        <section className="card">
          <h2>
            {passed} of {results.length} clean
          </h2>
          <div className="row">
            <button
              type="button"
              className="link"
              onClick={() => {
                // Downloaded rather than shown, so it goes back into whatever
                // spreadsheet the cases came from.
                const blob = new Blob([resultsToCsv(results)], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'eval-results.csv';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download results as CSV
            </button>
          </div>

          <ul className="events" style={{ maxHeight: '28rem' }}>
            {results.map((r) => (
              <li key={r.id} style={{ whiteSpace: 'normal' }}>
                <strong>{r.failures.length === 0 ? '✓' : '✕'} {r.id}</strong>{' '}
                <span className="muted">{r.ms} ms</span>
                <div className="muted">{r.turn || '(no output)'}</div>
                {r.failures.map((f) => (
                  <div key={f.check} className="eval-fail">
                    {f.check}: {f.detail}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
