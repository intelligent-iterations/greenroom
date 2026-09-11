import { NON_LLM_STAGE_VRAM_MB } from '@greenroom/shared';
import type { ModelDescriptor } from '@greenroom/shared';
import type { DeviceCapabilities } from '../voice/capabilities.js';
import { MODEL_CATALOGUE } from '../voice/models.js';
import { useAppStore } from '../state/store.js';

/**
 * Which model answers, and what that costs you.
 *
 * Lifted out of the device card, where it had been sitting among read-only
 * facts about the GPU. Choosing a model is the most consequential decision on
 * this screen — it sets the download, the latency and the quality — and it was
 * presented as a footnote to a hardware report.
 *
 * Three things are shown for every option because all three change the answer
 * for a real person: how big the download is, how fast the first word arrives,
 * and how good it is. A picker that shows only names asks people to choose
 * between words they cannot evaluate.
 *
 * Ordered by capability descending, so the list reads as a ladder and the
 * trade-off is legible: everything below is smaller, faster and weaker.
 */
export function ModelPicker({ capabilities }: { capabilities: DeviceCapabilities }) {
  const { modelId, setModelId } = useAppStore();

  // Judged against what is left after the recogniser and the voice take their
  // share, not against total memory: all three stages share one GPU, and
  // sizing the model against the whole budget is how you get a picker that
  // offers something which then fails to load.
  const budgetMb =
    capabilities.maxBufferMb === undefined
      ? undefined
      : Math.max(0, capabilities.maxBufferMb - NON_LLM_STAGE_VRAM_MB);

  const models = MODEL_CATALOGUE.filter((m) => m.vendor === 'on-device').sort(
    (a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0),
  );

  const fits = (model: ModelDescriptor): boolean =>
    budgetMb === undefined || (model.vramMb ?? 0) <= budgetMb;

  return (
    <section className="card">
      <h2>Which model answers</h2>
      <p className="muted small">
        Everything here runs in this tab. Bigger models hold a character better and take
        longer to download; the difference is audible.
      </p>

      <ul className="picker" role="radiogroup" aria-label="Model">
        <li>
          <label className={`picker__row ${!modelId ? 'picker__row--active' : ''}`}>
            <input
              type="radio"
              name="model"
              checked={!modelId}
              onChange={() => setModelId(undefined)}
            />
            <span className="picker__body">
              <span className="picker__name">Choose for me</span>
              <span className="picker__note muted small">
                The best one this machine can hold. Changes if you switch machines.
              </span>
            </span>
          </label>
        </li>

        {models.map((model) => {
          const available = fits(model);
          return (
            <li key={model.id}>
              <label
                className={`picker__row ${modelId === model.id ? 'picker__row--active' : ''} ${
                  available ? '' : 'picker__row--unavailable'
                }`}
              >
                <input
                  type="radio"
                  name="model"
                  disabled={!available}
                  checked={modelId === model.id}
                  onChange={() => setModelId(model.id)}
                />
                <span className="picker__body">
                  <span className="picker__name">{model.label}</span>
                  <span className="picker__meta">
                    <span>{formatSize(model.downloadMb)}</span>
                    <span>{formatLatency(model.firstTokenMsP50)} to first word</span>
                  </span>
                  <span className="picker__note muted small">{model.suitedTo}</span>
                  {/* Named rather than merely greyed out. A disabled row with no
                      reason reads as a bug in the app rather than a limit of
                      the machine. */}
                  {!available && (
                    <span className="picker__blocked small">
                      Needs about {formatSize(model.vramMb)} of graphics memory; this machine
                      has roughly {formatSize(budgetMb)} free once speech and voice are loaded.
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function formatSize(mb: number | undefined): string {
  if (mb === undefined) return 'unknown size';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/**
 * Only SmolLM2 1.7B is measured; the rest are scaled by parameter count.
 * `models.ts` says so, and a number presented without that caveat would be
 * read as a measurement.
 */
function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return 'unmeasured';
  return ms >= 1000 ? `~${(ms / 1000).toFixed(1)}s` : `~${ms}ms`;
}
