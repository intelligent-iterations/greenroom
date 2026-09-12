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
import { ModelPicker } from './ModelPicker.js';

const LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

/**
 * The room before the room.
 *
 * Previously five cards of equal weight — preset, device, model, storage,
 * source — with the one thing anyone came here to do sitting underneath them as
 * an ordinary button, disabled and silent whenever the router could not pick a
 * model. Someone whose GPU was too small saw a wall of settings, no way in, and
 * nothing telling them why.
 *
 * So: one action at the top, its blocker explained beside it, and the
 * configuration folded away behind a disclosure that opens itself only when
 * something needs solving. Configuration is not the product; the conversation
 * is.
 */
export function SetupScreen({
  learner,
  session,
}: {
  learner: LearnerState;
  session: ReturnType<typeof useSession>;
}) {
  const { setLearner, error, presetId } = useAppStore();
  const [starting, setStarting] = useState(false);

  const selected = session.routing?.selected;
  const ready = Boolean(selected);
  const rejected = session.routing?.rejected ?? [];
  const downloadGb = selected ? (((selected.downloadMb ?? 0) + 586) / 1000).toFixed(1) : undefined;

  return (
    <div className="stack">
      <section className="hero">
        <h2 className="hero__title">Talk to a model, then see how it did</h2>
        <p className="hero__lede">
          Speech recognition, the model and the voice all run in this tab. Nothing you say
          leaves this machine.
        </p>

        <button
          type="button"
          className="hero__go"
          disabled={!ready || starting}
          onClick={async () => {
            setStarting(true);
            await session.start(learner);
            setStarting(false);
          }}
        >
          {starting ? 'Getting the models…' : 'Start talking'}
        </button>

        {/* A disabled primary action says why, next to itself. Sending someone
            to a diagnostics card to find out is how a limit reads as a bug. */}
        {!ready && !starting && (
          <p className="hero__blocked">
            {session.capabilities === undefined
              ? 'Checking what this machine can run…'
              : rejected.length > 0
                ? `No model fits this machine yet — ${rejected[0]?.reason ?? 'nothing eligible'}. Open Setup to choose a smaller one.`
                : 'No model is eligible on this machine. Open Setup for the details.'}
          </p>
        )}

        {ready && (
          <p className="hero__meta">
            {selected?.label} · first run downloads {downloadGb} GB and keeps it, then works
            offline
          </p>
        )}
      </section>

      <p className="aside">
        Or{' '}
        <button
          type="button"
          className="link"
          onClick={() => useAppStore.getState().setPhase('evals')}
        >
          run an evaluation
        </button>{' '}
        against whichever model you pick.
      </p>

      {error && <p className="error">{error}</p>}

      <details className="setup" open={!ready}>
        <summary className="setup__summary">Setup</summary>
        <div className="setup__body">
          <PresetPicker learner={learner} />

          {/* Only where it changes anything. A rubber duck does not pitch its
              register at a CEFR level, and offering the control there implies
              it does. */}
          {presetId.startsWith('interview:') && (
            <section className="card">
              <h2>Your language level</h2>
              <p className="muted small">
                Changes how it speaks to you. It does not make the questions easier.
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

          {session.capabilities && <ModelPicker capabilities={session.capabilities} />}

          <DeviceReadiness session={session} />

          <section className="card">
            <h2>Where the models go</h2>
            <ModelDestination neededMb={(selected?.downloadMb ?? 0) + 586} />
          </section>

          <ModelSource />
        </div>
      </details>
    </div>
  );
}
