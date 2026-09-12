import { LATENCY_BUDGET } from '@greenroom/shared';
import { useEffect, useRef } from 'react';
import { median, useAppStore } from '../state/store.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';
import { DownloadPanel } from './DownloadPanel.js';
import type { useSession } from '../state/useSession.js';

/**
 * What the machine is doing, in the second person.
 *
 * "Transcribing" and "inference" describe the implementation; a person in a
 * conversation needs to know whose turn it is. These are the four states that
 * change what they should do with their voice, and the wording says so.
 */
const STATE_LABEL: Record<string, string> = {
  loading: 'Getting ready',
  listening: 'Listening',
  transcribing: 'Got that',
  thinking: 'Thinking',
  speaking: 'Speaking',
  ended: 'Finished',
  error: 'Something went wrong',
  idle: 'Idle',
};

const STATE_HINT: Record<string, string> = {
  listening: 'Talk, then pause when you are done',
  speaking: 'Talk over it to interrupt',
  thinking: 'One moment',
  transcribing: 'Working out what you said',
};

export function SessionScreen({ session }: { session: ReturnType<typeof useSession> }) {
  const { sessionState, turns, liveText, latency, error } = useAppStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows. Anchored to the transcript container
  // rather than the window so it does not fight someone scrolling back.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length, liveText]);

  const firstAudio = median(
    latency.map((l) => l.firstAudioMs).filter((v): v is number => v !== undefined),
  );

  const spoken = turns.filter((t) => t.role !== 'system');

  return (
    <div className="live">
      {/* The one thing that moves on this screen. Everything else is still, so
          the pulse reads as "the room is live" rather than as decoration. */}
      <section className={`vu vu--${sessionState}`} aria-live="polite">
        <span className="vu__lamp" aria-hidden="true" />
        <span className="vu__text">
          <strong className="vu__state">{STATE_LABEL[sessionState] ?? sessionState}</strong>
          {STATE_HINT[sessionState] && (
            <span className="vu__hint">{STATE_HINT[sessionState]}</span>
          )}
        </span>
        {firstAudio !== undefined && (
          <span
            className={`vu__latency ${
              firstAudio <= LATENCY_BUDGET.firstAudioGoodMs
                ? 'is-good'
                : firstAudio <= LATENCY_BUDGET.firstAudioAcceptableMs
                  ? 'is-ok'
                  : 'is-slow'
            }`}
            title="Median time from when you stop speaking to when it starts replying"
          >
            {Math.round(firstAudio)}ms
          </span>
        )}
      </section>

      {sessionState === 'loading' && <DownloadPanel />}

      <div className="transcript" ref={scrollRef}>
        {spoken.length === 0 && !liveText && (
          <p className="transcript__empty">
            {sessionState === 'loading'
              ? 'It will speak first.'
              : 'Say something to begin.'}
          </p>
        )}

        {spoken.map((turn) => (
          <article key={turn.id} className={`said said--${turn.role}`}>
            <p className="said__text">{turn.text}</p>
            {turn.bargedIn && turn.role !== 'learner' && (
              <p className="said__note">you cut in here</p>
            )}
          </article>
        ))}

        {liveText && (
          <article className="said said--interviewer said--live">
            <p className="said__text">{liveText}</p>
          </article>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="live__controls">
        <button type="button" className="ghost" onClick={() => void session.stop()}>
          End and get feedback
        </button>
        <DiagnosticsPanel />
      </div>
    </div>
  );
}
