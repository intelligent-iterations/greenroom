import { useRef, useState } from 'react';
import { useAppStore } from '../state/store.js';
import {
  filesFromInput,
  inspectLocalModel,
  pickModelDirectory,
  supportsDirectoryPicker,
} from '../voice/local-models.js';

/**
 * Sources a model from somewhere other than the built-in catalogue.
 *
 * Two escapes, because the catalogue will always be out of date: any Hugging
 * Face repo with ONNX weights, and a folder already on the machine. The second
 * matters more than it looks — someone evaluating on-device models usually has
 * several downloaded already, and asking them to fetch another two gigabytes
 * to try this is the reason they would not bother.
 */
export function ModelSource() {
  const {
    customModelRepo,
    setCustomModelRepo,
    localModelLabel,
    setLocalModel,
    setModelId,
  } = useAppStore();

  const [repo, setRepo] = useState(customModelRepo ?? '');
  const [status, setStatus] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  function applyFiles(files: Map<string, File>, label: string) {
    const check = inspectLocalModel(files);
    if (!check.usable) {
      // Said up front rather than discovered deep inside the loader, which is
      // where this otherwise surfaces — minutes in, as a missing-file error.
      setStatus(
        check.weightFiles.length === 0
          ? 'No .onnx weights in that folder.'
          : `Missing ${check.missing.join(' and ')}. Pick the folder containing config.json.`,
      );
      return;
    }
    setLocalModel([...files.entries()], label);
    setStatus(`Using ${label} — ${check.weightFiles.length} weight file(s) found.`);
  }

  return (
    <section className="card">
      <h2>Or bring your own model</h2>

      <label className="stack">
        <span className="muted small">
          Any Hugging Face repository with ONNX weights, e.g.{' '}
          <code>onnx-community/Qwen3-1.7B-ONNX</code>.
        </span>
        <div className="row">
          <input
            type="text"
            className="repo-input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/model-name"
            spellCheck={false}
          />
          <button
            type="button"
            className="primary small-btn"
            onClick={() => {
              const trimmed = repo.trim();
              setCustomModelRepo(trimmed || undefined);
              // A typed repo overrides the catalogue selection, not both at once.
              if (trimmed) setModelId(undefined);
              setStatus(trimmed ? `Will load ${trimmed}.` : undefined);
            }}
          >
            Use it
          </button>
        </div>
      </label>

      <div className="row" style={{ marginTop: '0.9rem' }}>
        <button
          type="button"
          className="link"
          onClick={async () => {
            try {
              if (supportsDirectoryPicker()) {
                const picked = await pickModelDirectory();
                if (picked) applyFiles(picked.files, picked.label);
              } else {
                fileInput.current?.click();
              }
            } catch {
              // The user dismissed the picker. Not an error worth reporting.
            }
          }}
        >
          Use a folder I already have
        </button>
        {localModelLabel && (
          <button type="button" className="link" onClick={() => { setLocalModel(undefined); setStatus(undefined); }}>
            Clear
          </button>
        )}
      </div>

      {/* Fallback for browsers without showDirectoryPicker. */}
      <input
        ref={fileInput}
        type="file"
        hidden
        // @ts-expect-error - non-standard but the only way to select a folder here
        webkitdirectory=""
        directory=""
        multiple
        onChange={(e) => {
          if (e.target.files) {
            const picked = filesFromInput(e.target.files);
            applyFiles(picked.files, picked.label);
          }
        }}
      />

      {status && <p className="muted small">{status}</p>}
      <p className="muted small">
        Files stay on your machine. They are read directly by the page and answer the
        model loader before it reaches the network; anything missing is downloaded.
      </p>
    </section>
  );
}
