import { LATENCY_BUDGET } from '@greenroom/shared';
import { useEffect, useRef } from 'react';
import { median, useAppStore } from '../state/store.js';
import type { useSession } from '../state/useSession.js';

const STATE_LABEL: Record<string, string> = {
  loading: 'Getting ready',
  listening: 'Listening',
  transcribing: 'Reading that back',
  thinking: 'Thinking',
  speaking: 'Speaking',
  ended: 'Finished',
  error: 'Something went wrong',
  idle: 'Idle',
};

export function SessionScreen({ session }: { session: ReturnType<typeof useSession> }) {
  const { sessionState, turns, liveText, progress, latency, error } = useAppStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows. Anchored to the transcript container
  // rather than the window so it does not fight a learner scrolling back.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, liveText]);

  const firstAudio = median(
    latency.map((l) => l.firstAudioMs).filter((v): v is number => v !== undefined),
  );

  return (
    <div className="stack">
      <section className={`status status--${sessionState}`}>
        <span className="status__dot" aria-hidden="true" />
        <strong>{STATE_LABEL[sessionState] ?? sessionState}</strong>
        {sessionState === 'listening' && <span className="muted"> — just start talking</span>}
        {sessionState === 'speaking' && <span className="muted"> — interrupt any time</span>}
      </section>

      {sessionState === 'loading' && progress && (
        <div className="card">
          <p>{progress.stage}</p>
          <progress value={progress.progress} max={1} />
        </div>
      )}

      <div className="transcript" ref={scrollRef}>
        {turns
          .filter((t) => t.role !== 'system')
          .map((turn) => (
            <p key={turn.id} className={`turn turn--${turn.role}`}>
              <span className="turn__who">
                {turn.role === 'interviewer' ? 'Interviewer' : 'You'}
              </span>
              {turn.text}
              {turn.bargedIn && turn.role === 'interviewer' && (
                <span className="muted small"> (you cut in)</span>
              )}
            </p>
          ))}
        {liveText && (
          <p className="turn turn--interviewer turn--live">
            <span className="turn__who">Interviewer</span>
            {liveText}
          </p>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="row">
        <button type="button" className="primary" onClick={() => void session.stop()}>
          End and get feedback
        </button>
        {firstAudio !== undefined && (
          <span
            className={`latency ${
              firstAudio <= LATENCY_BUDGET.firstAudioGoodMs
                ? 'latency--good'
                : firstAudio <= LATENCY_BUDGET.firstAudioAcceptableMs
                  ? 'latency--ok'
                  : 'latency--slow'
            }`}
            title="Median time from when you stop speaking to when the interviewer starts"
          >
            {Math.round(firstAudio)} ms to reply
          </span>
        )}
      </div>
    </div>
  );
}
