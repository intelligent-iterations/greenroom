import { NON_LLM_STAGE_VRAM_MB } from '@greenroom/shared';
import { useAppStore } from '../state/store.js';
import { cloudInferenceOffered } from '../data/deployment.js';
import type { useSession } from '../state/useSession.js';
import { MODEL_CATALOGUE } from '../voice/models.js';

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
  const { allowCloud, setAllowCloud, modelId, setModelId } = useAppStore();

  if (!capabilities) return <section className="card">Checking this device…</section>;

  const selected = routing?.selected;
  const onDevice = selected?.residency === 'device';

  // What is left for the interviewer after the recogniser and voice take theirs.
  const budgetMb =
    capabilities.maxBufferMb === undefined
      ? undefined
      : Math.max(0, capabilities.maxBufferMb - NON_LLM_STAGE_VRAM_MB);

  const onDeviceModels = MODEL_CATALOGUE.filter((m) => m.vendor === 'on-device');

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

      <fieldset className="models">
        <legend>Interviewer model</legend>
        <p className="muted small">
          Bigger models stay in character better and take longer to download. Anything
          your machine cannot hold is shown but not selectable.
        </p>

        <label className="model">
          <input
            type="radio"
            name="model"
            checked={!modelId}
            onChange={() => setModelId(undefined)}
          />
          <span>
            <strong>Choose for me</strong>
            <span className="muted small"> — best that fits this machine</span>
          </span>
        </label>

        {onDeviceModels.map((model) => {
          // Judged against the memory left after the other stages, not total,
          // because all three models share one GPU.
          const fits = budgetMb === undefined || (model.vramMb ?? 0) <= budgetMb;
          return (
            <label key={model.id} className={`model ${fits ? '' : 'model--unavailable'}`}>
              <input
                type="radio"
                name="model"
                disabled={!fits}
                checked={modelId === model.id}
                onChange={() => setModelId(model.id)}
              />
              <span>
                <strong>{model.label}</strong>
                <span className="muted small">
                  {' '}
                  — {model.downloadMb} MB download
                  {fits ? '' : ' · too large for this device'}
                </span>
                <span className="muted small model__note">{model.suitedTo}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {cloudInferenceOffered() ? (
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
