import { useRealtime, type SetupGate } from '../state/useRealtime.js';

/**
 * One model, speech in and speech out, and the four things that have to be true
 * before it can run.
 *
 * Shown as a checklist rather than a button, because a two-gigabyte setup fails
 * in specific ways — no WebGPU, no folder, half a download — and each wants a
 * different repair. The previous screen collapsed all of that into one control
 * that either worked or sat silently, which is how "it's stuck" became the only
 * available description.
 */

const GATE_ORDER: SetupGate[] = ['device', 'location', 'files', 'ready'];

function gb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function RealtimeScreen() {
  const rt = useRealtime();
  const { gates } = rt;
  const survey = gates.files.survey;
  const done = (g: SetupGate) => GATE_ORDER.indexOf(g) < GATE_ORDER.indexOf(rt.gate);
  const running = rt.phase === 'listening' || rt.phase === 'thinking' || rt.phase === 'speaking';

  const percent = rt.expected > 0 ? Math.min(100, (rt.loaded / rt.expected) * 100) : 0;
  const latest = rt.steps[rt.steps.length - 1];

  return (
    <div className="stack">
      <section className="hero">
        <h2 className="hero__title">One model. Speech in, speech out.</h2>
        <p className="hero__lede">
          LFM2.5-Audio runs end to end in this tab on WebGPU — no recogniser, no separate
          voice, no server. Prosody and content come from the same forward pass.
        </p>
      </section>

      {rt.error && <p className="error">{rt.error}</p>}

      {running ? (
        <>
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

          <div className="transcript">
            {rt.transcript.length === 0 && (
              <p className="transcript__empty">Say something to begin.</p>
            )}
            {rt.transcript.map((line, i) => (
              <article key={i} className={`said said--${line.role === 'you' ? 'learner' : 'interviewer'}`}>
                <p className="said__text">{line.text}</p>
              </article>
            ))}
          </div>

          <div className="live__controls">
            <button type="button" className="ghost" onClick={() => void rt.stop()}>
              End session
            </button>
          </div>
        </>
      ) : rt.phase === 'loading' ? (
        <section className="card">
          <h2>Getting the model</h2>
          {/* A real denominator from the first byte: the manifest knows the
              total before anything starts, so this never lurches. */}
          <div className="meter" role="progressbar" aria-valuenow={Math.round(percent)}>
            <span className="meter__fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="muted small">
            {gb(rt.loaded)} of {gb(rt.expected)} · {Math.round(percent)}%
          </p>
          {latest && (
            <p className="muted small">
              {latest.kind === 'checking' && `Checking ${latest.file}…`}
              {latest.kind === 'cached' && `${latest.file} already on disk`}
              {latest.kind === 'downloading' && `Downloading ${latest.file}`}
              {latest.kind === 'saving' && `Saving ${latest.file}`}
              {latest.kind === 'compiling' && `Compiling ${latest.file} for the GPU — this is slow`}
              {latest.kind === 'failed' && `${latest.file}: ${latest.reason}`}
            </p>
          )}
          <button type="button" className="ghost" onClick={rt.cancel}>
            Cancel
          </button>
        </section>
      ) : (
        <section className="card">
          <h2>Before it can run</h2>
          <ol className="gates">
            <li className={`gate ${gates.device.checked ? (gates.device.ok ? 'gate--ok' : 'gate--blocked') : ''}`}>
              <span className="gate__mark" aria-hidden="true">
                {gates.device.checked ? (gates.device.ok ? '✓' : '!') : '·'}
              </span>
              <span className="gate__body">
                <strong>This machine can run it</strong>
                <span className="muted small">
                  {!gates.device.checked
                    ? 'Checking for WebGPU…'
                    : gates.device.ok
                      ? 'WebGPU is available.'
                      : gates.device.detail}
                </span>
              </span>
            </li>

            <li className={`gate ${done('location') ? 'gate--ok' : rt.gate === 'location' ? 'gate--current' : ''}`}>
              <span className="gate__mark" aria-hidden="true">{done('location') ? '✓' : '·'}</span>
              <span className="gate__body">
                <strong>Somewhere to keep {gb(rt.model.downloadMb * 1_048_576)}</strong>
                {gates.location.name ? (
                  <span className="muted small">
                    {gates.location.needsPermission
                      ? `${gates.location.name} — reconnect to use it`
                      : `Files live in ${gates.location.name}`}
                  </span>
                ) : (
                  <span className="muted small">
                    {gates.location.supported
                      ? 'Pick a folder. Browser storage gets reclaimed; a folder does not, and the next session finds it here.'
                      : 'This browser has no folder picker, so the weights go to browser storage and may be reclaimed.'}
                  </span>
                )}
                {gates.location.supported && (
                  <span className="gate__actions">
                    {gates.location.needsPermission && (
                      <button type="button" className="secondary" onClick={() => void rt.reconnect()}>
                        Reconnect
                      </button>
                    )}
                    <button type="button" className="secondary" onClick={() => void rt.pickFolder()}>
                      {gates.location.name ? 'Choose a different folder' : 'Choose a folder'}
                    </button>
                  </span>
                )}
              </span>
            </li>

            <li className={`gate ${survey ? 'gate--ok' : ''}`}>
              <span className="gate__mark" aria-hidden="true">{survey ? '✓' : '·'}</span>
              <span className="gate__body">
                <strong>The model files</strong>
                <span className="muted small">
                  {!survey
                    ? 'Choose a folder and this will say what is already there.'
                    : gates.files.summary}
                </span>
                {/* Corrupt is said separately from missing: one downloads, the
                    other is replaced, and merging them makes a re-download look
                    like the app forgetting what it had. */}
                {survey && survey.corrupt.length > 0 && (
                  <span className="muted small">
                    {survey.corrupt.length} file
                    {survey.corrupt.length === 1 ? ' was' : 's were'} left incomplete by an
                    interrupted download and will be fetched again.
                  </span>
                )}
              </span>
            </li>
          </ol>

          <button
            type="button"
            className="hero__go"
            disabled={rt.gate !== 'ready'}
            onClick={() => void rt.start()}
          >
            {survey && survey.missing.length === 0 && survey.corrupt.length === 0
              ? 'Start talking'
              : 'Download and start'}
          </button>
          {rt.gate !== 'ready' && (
            <p className="hero__blocked">
              {rt.gate === 'device'
                ? 'This machine cannot run the model yet.'
                : rt.gate === 'location'
                  ? 'Choose where the files go first — without it a download would not survive a reload.'
                  : 'Checking the folder…'}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
