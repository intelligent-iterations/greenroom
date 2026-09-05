import { COMPETENCY_LABELS, SCENARIOS, type CefrLevel, type LearnerState } from '@greenroom/shared';
import { useState } from 'react';
import { useAppStore } from '../state/store.js';
import type { useSession } from '../state/useSession.js';
import { DeviceReadiness } from './DeviceReadiness.js';

const LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export function SetupScreen({
  learner,
  session,
}: {
  learner: LearnerState;
  session: ReturnType<typeof useSession>;
}) {
  const { scenarioId, setScenario, setLearner, error } = useAppStore();
  const [starting, setStarting] = useState(false);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  const ready = Boolean(session.routing?.selected);

  return (
    <div className="stack">
      <section className="card">
        <h2>Choose a scenario</h2>
        <div className="scenario-grid">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`scenario ${s.id === scenarioId ? 'scenario--active' : ''}`}
              onClick={() => setScenario(s.id)}
              aria-pressed={s.id === scenarioId}
            >
              <strong>{s.title}</strong>
              <span className="muted">
                {s.company} · {s.language.toUpperCase()}
              </span>
            </button>
          ))}
        </div>
        {scenario && (
          <p className="muted">
            Trains{' '}
            {scenario.targetCompetencies
              .map((c) => COMPETENCY_LABELS[c].toLowerCase())
              .join(', ')}
            . About {scenario.maxTurns} questions.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Your language level</h2>
        <p className="muted">
          This changes how the interviewer speaks to you. It does not make the questions easier.
        </p>
        <div className="levels" role="group" aria-label="CEFR level">
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`level ${learner.cefr === level ? 'level--active' : ''}`}
              onClick={() => setLearner({ ...learner, cefr: level, updatedAt: Date.now() })}
              aria-pressed={learner.cefr === level}
            >
              {level}
            </button>
          ))}
        </div>
      </section>

      <DeviceReadiness session={session} />

      {error && <p className="error">{error}</p>}

      <button
        type="button"
        className="primary"
        disabled={!ready || starting}
        onClick={async () => {
          setStarting(true);
          await session.start(learner);
          setStarting(false);
        }}
      >
        {starting ? 'Loading models…' : 'Start the interview'}
      </button>
      <p className="muted small">
        The first run downloads about 1.2 GB of models and caches them. After that it works offline.
      </p>
    </div>
  );
}
