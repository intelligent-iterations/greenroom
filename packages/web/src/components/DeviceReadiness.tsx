import { useAppStore } from '../state/store.js';
import { cloudInferenceOffered } from '../data/deployment.js';
import { assessReadiness } from '../voice/readiness.js';
import type { useSession } from '../state/useSession.js';

/**
 * Explains what will run where, before anything downloads.
 *
 * Two audiences. Learners need to know whether their voice leaves the machine,
 * which is the product's whole premise and cannot be buried in a privacy page.
 * Whoever is debugging needs the routing decision — "why am I on the slow
 * model" is the first question a portable stack generates, and the router
 * already records the answer, so it is shown rather than logged.
 */
export function DeviceReadiness({ session }: { session: ReturnType<typeof useSession> }) {
  const { capabilities, routing } = session;
  const { allowCloud, setAllowCloud } = useAppStore();

  if (!capabilities) return <section className="card">Checking this device…</section>;

  const readiness = assessReadiness(capabilities);

  const selected = routing?.selected;
  const onDevice = selected?.residency === 'device';

  return (
    <section className="card">
      <h2>This device</h2>

      <dl className="facts">
        <div>
          <dt>Graphics acceleration</dt>
          <dd>{capabilities.hasWebGpu ? (capabilities.gpuDescription ?? 'WebGPU') : 'Not available'}</dd>
        </div>
        <div>
          <dt>Fast multi-threaded audio</dt>
          <dd>{capabilities.hasSharedArrayBuffer ? `Yes, ${capabilities.threads} threads` : 'Single-threaded'}</dd>
        </div>
        <div>
          <dt>Answering</dt>
          <dd>{selected ? selected.label : 'No eligible model'}</dd>
        </div>
      </dl>

      <p className={onDevice ? 'badge badge--good' : 'badge badge--warn'}>
        {onDevice
          ? 'Your microphone audio and what you say stay on this device.'
          : 'What you say will be sent to a cloud model for this session.'}
      </p>

      {readiness.level !== 'full' && (
        <div className={`notice notice--${readiness.level}`} role="status">
          <strong>{readiness.headline}</strong>
          <p className="muted small">{readiness.detail}</p>
          {readiness.level === 'degraded' && <p className="muted small">{readiness.expect}</p>}
          {readiness.level === 'blocked' && (
            <ul className="muted small">
              {readiness.remedies.map((remedy) => (
                <li key={remedy}>{remedy}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cloudInferenceOffered() ? (
        <label className="toggle">
          <input
            type="checkbox"
            checked={allowCloud}
            onChange={(e) => setAllowCloud(e.target.checked)}
          />
          <span>
            Allow cloud inference for a stronger model
            <span className="muted small"> — needed if this device has no WebGPU</span>
          </span>
        </label>
      ) : (
        <p className="muted small">
          This deployment runs on-device only. Nothing you say and nothing you type leaves
          this machine. The cloud adapters ship in the source for anyone self-hosting who
          wants them, with their own key.
        </p>
      )}

      {(routing?.rejected.length ?? 0) > 0 && (
        <details className="diagnostics">
          <summary>Why this model?</summary>
          <ul>
            {routing?.rejected.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> — {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
