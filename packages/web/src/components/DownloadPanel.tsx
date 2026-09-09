import { useAppStore } from '../state/store.js';
import { formatBytes, formatEta } from '../state/download.js';

/**
 * What is happening while a gigabyte arrives.
 *
 * The old version was a single bar and a stage name. It went backwards twice
 * per load — every stage restarted it, and every file within a stage restarted
 * it again — so the most common reading was that something had failed and
 * begun again.
 *
 * Every stage holds its place here from the first frame. Only the one actually
 * working animates, a stage already on disk says so rather than racing to a
 * hundred, and the numbers are real bytes rather than a percentage of an
 * unnamed whole. Tabular figures, because a counter whose digits change width
 * reads as noise.
 */
export function DownloadPanel() {
  const download = useAppStore((s) => s.download);
  if (!download) return null;

  const { stages, loadedBytes, totalBytes, fraction, bytesPerSecond, etaSeconds, done } = download;
  const percent = Math.round(fraction * 100);

  return (
    <section className="download" aria-live="polite">
      <div className="download__head">
        <h2 className="download__title">{done ? 'Ready' : 'Getting the models'}</h2>
        <p className="download__figures">
          {done ? (
            <>{formatBytes(loadedBytes)} on this machine</>
          ) : (
            <>
              {formatBytes(loadedBytes)} of {formatBytes(totalBytes)}
              {bytesPerSecond ? <> · {formatBytes(bytesPerSecond)}/s</> : null}
              {etaSeconds ? <> · {formatEta(etaSeconds)} left</> : null}
            </>
          )}
        </p>
      </div>

      <div
        className="download__overall"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Overall download"
      >
        <span className="download__fill" style={{ inlineSize: `${percent}%` }} />
      </div>

      <ul className="download__stages">
        {stages.map((stage) => {
          const known = stage.reportedBytes || stage.expectedBytes;
          const within = known > 0 ? Math.min(1, stage.loadedBytes / known) : 0;
          const active = !stage.done && stage.loadedBytes > 0;
          return (
            <li
              key={stage.stage}
              className={`stage ${stage.done ? 'stage--done' : ''} ${active ? 'stage--active' : ''}`}
            >
              <span className="stage__name">{stage.label}</span>
              <span className="stage__track">
                <span className="stage__fill" style={{ inlineSize: `${Math.round(within * 100)}%` }} />
              </span>
              <span className="stage__note">
                {stage.cached
                  ? 'already here'
                  : stage.done
                    ? formatBytes(stage.reportedBytes || stage.expectedBytes)
                    : active
                      ? `${formatBytes(stage.loadedBytes)} of ${formatBytes(known)}`
                      : formatBytes(stage.expectedBytes)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
