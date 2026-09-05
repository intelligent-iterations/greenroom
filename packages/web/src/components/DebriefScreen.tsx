import { COMPETENCY_LABELS, type LearnerState } from '@greenroom/shared';
import { useEffect, useState } from 'react';
import { median, percentile, useAppStore } from '../state/store.js';
import type { useSession } from '../state/useSession.js';

export function DebriefScreen({
  learner,
  session,
}: {
  learner: LearnerState;
  session: ReturnType<typeof useSession>;
}) {
  const { turns, latency, setPhase, resetSession } = useAppStore();
  const [feedback, setFeedback] = useState('');
  const [status, setStatus] = useState<'writing' | 'done' | 'failed'>('writing');

  const instance = session.session;

  useEffect(() => {
    if (!instance) return setStatus('failed');
    const abort = new AbortController();

    void (async () => {
      try {
        let text = '';
        for await (const delta of instance.debrief(abort.signal)) {
          text += delta;
          setFeedback(text);
        }
        setStatus('done');
      } catch {
        // Aborting on unmount lands here too; the state is discarded either way.
        setStatus('failed');
      }
    })();

    return () => abort.abort();
  }, [instance]);

  const answered = turns.filter((t) => t.role === 'learner').length;
  const firstAudioSamples = latency
    .map((l) => l.firstAudioMs)
    .filter((v): v is number => v !== undefined);
  const interruptions = latency.filter((l) => l.bargedIn).length;

  return (
    <div className="stack">
      <section className="card">
        <h2>How that went</h2>
        {status === 'writing' && !feedback && <p className="muted">Writing your feedback…</p>}
        {status === 'failed' && !feedback && (
          <p className="muted">Feedback is not available for this session.</p>
        )}
        <p className="feedback">{feedback}</p>
      </section>

      <section className="card">
        <h2>This session</h2>
        <dl className="facts">
          <div>
            <dt>Questions answered</dt>
            <dd>{answered}</dd>
          </div>
          <div>
            <dt>Times you interrupted</dt>
            <dd>{interruptions}</dd>
          </div>
          <div>
            <dt>Median reply time</dt>
            <dd>
              {firstAudioSamples.length > 0
                ? `${Math.round(median(firstAudioSamples) ?? 0)} ms`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Slowest reply (p95)</dt>
            <dd>
              {firstAudioSamples.length > 0
                ? `${Math.round(percentile(firstAudioSamples, 95) ?? 0)} ms`
                : '—'}
            </dd>
          </div>
        </dl>
        <p className="muted small">
          Trained this session:{' '}
          {(instance?.prompt.focus ?? [])
            .map((c) => COMPETENCY_LABELS[c].toLowerCase())
            .join(' and ')}
          . You have completed {learner.sessionsCompleted} sessions.
        </p>
      </section>

      <button
        type="button"
        className="primary"
        onClick={() => {
          resetSession();
          setPhase('setup');
        }}
      >
        Practise again
      </button>
    </div>
  );
}
