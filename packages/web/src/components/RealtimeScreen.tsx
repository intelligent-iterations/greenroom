import { useRealtime } from '../state/useRealtime.js';
import { chooseModelFolder, supportsModelFolder } from '../voice/model-store.js';

/**
 * One model, speech in and speech out, running in this tab.
 *
 * The cascade's screen explains three stages because it has three. This one has
 * a single model, so the screen is about the two things that actually gate it:
 * whether the machine has WebGPU, and where two gigabytes of weights are going
 * to live.
 */
export function RealtimeScreen() {
  const rt = useRealtime();
  const canChoose = supportsModelFolder();

  const downloaded = rt.files.filter((f) => f.cached).length;
  const inFlight = rt.files.filter((f) => !f.cached && f.total && f.loaded < f.total);
  const totalBytes = rt.files.reduce((sum, f) => sum + (f.total ?? 0), 0);
  const loadedBytes = rt.files.reduce((sum, f) => sum + f.loaded, 0);

  return (
    <div className="stack">
      <section className="hero">
        <h2 className="hero__title">One model. Speech in, speech out.</h2>
        <p className="hero__lede">
          LFM2.5-Audio runs end to end in this tab on WebGPU — no recogniser, no separate
          voice, no server. Prosody and content come from the same forward pass.
        </p>

        {rt.phase === 'idle' || rt.phase === 'ready-to-load' ? (
          <button type="button" className="hero__go" onClick={() => void rt.load()}>
            {rt.survey?.missing === 0 ? 'Start talking' : 'Download and start'}
          </button>
        ) : rt.phase === 'loading' ? (
          <button type="button" className="hero__go" disabled>
            Loading the model…
          </button>
        ) : rt.phase === 'blocked' || rt.phase === 'error' ? (
          <button type="button" className="hero__go" onClick={() => void rt.load()}>
            Try again
          </button>
        ) : (
          <button type="button" className="ghost" onClick={() => void rt.stop()}>
            End session
          </button>
        )}

        {rt.message && (
          <p className={rt.phase === 'blocked' || rt.phase === 'error' ? 'hero__blocked' : 'hero__meta'}>
            {rt.message}
          </p>
        )}
        {!rt.message && rt.phase === 'idle' && (
          <p className="hero__meta">
            {rt.model.label} · about {(rt.model.downloadMb / 1024).toFixed(1)} GB, downloaded once
          </p>
        )}
      </section>

      {(rt.phase === 'listening' || rt.phase === 'thinking' || rt.phase === 'speaking') && (
        <section className={`vu vu--${rt.phase}`} aria-live="polite">
          <span className="vu__lamp" aria-hidden="true" />
          <span className="vu__text">
            <strong className="vu__state">
              {rt.phase === 'listening' ? 'Listening' : rt.phase === 'thinking' ? 'Thinking' : 'Speaking'}
            </strong>
            <span className="vu__hint">
              {rt.phase === 'listening' ? 'Talk, then pause' : 'One moment'}
            </span>
          </span>
        </section>
      )}

      {rt.transcript.length > 0 && (
        <div className="transcript">
          {rt.transcript.map((line, i) => (
            <article key={i} className={`said said--${line.role === 'you' ? 'learner' : 'interviewer'}`}>
              <p className="said__text">{line.text}</p>
            </article>
          ))}
        </div>
      )}

      {rt.phase === 'loading' && (
        <section className="card">
          <h2>Getting the model</h2>
          <p className="muted small">
            {downloaded > 0 && `${downloaded} files already on disk. `}
            {totalBytes > 0 &&
              `${(loadedBytes / 1_073_741_824).toFixed(2)} of ${(totalBytes / 1_073_741_824).toFixed(2)} GB`}
          </p>
          {inFlight.map((f) => (
            <p key={f.file} className="muted small">
              {f.file} — {Math.round((f.loaded / (f.total ?? 1)) * 100)}%
            </p>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Where the model goes</h2>
        {rt.folder ? (
          <p className="destination__current">
            Files live in <strong>{rt.folder.name}</strong>
            {rt.survey && rt.survey.missing === 0 && ' — complete, nothing to download'}
            {rt.survey && rt.survey.missing > 0 && ` — ${rt.survey.present} of ${rt.survey.present + rt.survey.missing} present`}
          </p>
        ) : (
          <p className="muted small">
            Two gigabytes is not something to download twice. Pick a folder and the weights
            stay there — on the next visit, choose the same folder and nothing is fetched.
          </p>
        )}
        {canChoose && (
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              const handle = await chooseModelFolder();
              if (handle) await rt.chooseFolder(handle);
            }}
          >
            {rt.folder ? 'Choose a different folder' : 'Choose a folder'}
          </button>
        )}
        {!canChoose && (
          <p className="muted small">
            This browser cannot offer a folder picker, so the weights go to browser storage and
            may be reclaimed. Chrome or Edge keeps them where you put them.
          </p>
        )}
      </section>
    </div>
  );
}
