import { useAppStore } from '../state/store.js';
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
          <dt>Running the interviewer</dt>
          <dd>{selected ? selected.label : 'No eligible model'}</dd>
        </div>
      </dl>

      <p className={onDevice ? 'badge badge--good' : 'badge badge--warn'}>
        {onDevice
          ? 'Your microphone audio and answers stay on this device.'
          : 'Your answers will be sent to a cloud model for this session.'}
      </p>

      <label className="toggle">
        <input
          type="checkbox"
          checked={allowCloud}
          onChange={(e) => setAllowCloud(e.target.checked)}
        />
        <span>
          Allow cloud inference for a stronger interviewer
          <span className="muted small"> — needed if this device has no WebGPU</span>
        </span>
      </label>

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
