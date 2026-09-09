import {
  type CefrLevel,
  type LearnerState,
} from '@greenroom/shared/interview';
import { useState } from 'react';
import { useAppStore } from '../state/store.js';
import type { useSession } from '../state/useSession.js';
import { DeviceReadiness } from './DeviceReadiness.js';
import { ModelSource } from './ModelSource.js';
import { PresetPicker } from './PresetPicker.js';
import { ModelDestination } from './ModelDestination.js';

const LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

export function SetupScreen({
  learner,
  session,
}: {
  learner: LearnerState;
  session: ReturnType<typeof useSession>;
}) {
  const { setLearner, error, presetId } = useAppStore();
  const [starting, setStarting] = useState(false);

  const ready = Boolean(session.routing?.selected);

  return (
    <div className="stack">
      <PresetPicker learner={learner} />

      {/* Only where it changes anything. A rubber duck does not pitch its
          register at a CEFR level, and offering the control there implies it
          does. */}
      {presetId.startsWith('interview:') && (
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
      )}

      <DeviceReadiness session={session} />

      <section className="card">
        <h2>Where the models go</h2>
        <ModelDestination />
      </section>

      <ModelSource />

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
        {starting ? 'Getting the models' : 'Start talking'}
      </button>
      <p className="muted small">
        <button type="button" className="link" onClick={() => useAppStore.getState().setPhase('evals')}>
          Run your own evaluations
        </button>{' '}
        against whichever model you pick.
      </p>
      <p className="muted small">
        {session.routing?.selected
          ? `First run downloads about ${(((session.routing.selected.downloadMb ?? 0) + 586) / 1000).toFixed(1)} GB and keeps it. After that it works offline.`
          : 'The first run downloads the models and keeps them. After that it works offline.'}
      </p>
    </div>
  );
}
