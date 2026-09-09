import { useEffect, useState } from 'react';
import { useAppStore } from '../state/store.js';
import {
  chooseModelFolder,
  forgetModelFolder,
  grantModelFolder,
  restoreModelFolder,
  supportsModelFolder,
} from '../voice/model-store.js';

/**
 * Where the weights go.
 *
 * Browser storage is the default because it needs no decision and no
 * permission, but it is worth being honest that it is evictable: a browser
 * short of space can delete a gigabyte somebody waited ten minutes for, and
 * they find out by waiting ten minutes again.
 *
 * A folder is the better answer where the browser can offer one. The files are
 * then legible, shareable with other tools, backed up with everything else, and
 * read straight off disk on every later run.
 */
export function ModelDestination() {
  const { modelFolder, modelFolderName, modelFolderNeedsPermission, setModelFolder } = useAppStore();
  const [busy, setBusy] = useState(false);
  const supported = supportsModelFolder();

  useEffect(() => {
    if (!supported) return;
    void restoreModelFolder().then((found) => {
      if (found) setModelFolder(found.handle, found.handle.name, found.needsPermission);
    });
  }, [supported, setModelFolder]);

  if (!supported) {
    return (
      <p className="muted small">
        Models are kept in this browser&rsquo;s storage. Chrome and Edge can put them in a
        folder you choose instead, which survives a browser clearing space.
      </p>
    );
  }

  if (modelFolder) {
    return (
      <div className="destination">
        <p className="destination__current">
          Models live in <strong>{modelFolderName}</strong>
          {modelFolderNeedsPermission ? ' — reconnect to use it' : ''}
        </p>
        <div className="destination__actions">
          {modelFolderNeedsPermission && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const granted = await grantModelFolder(modelFolder);
                setModelFolder(modelFolder, modelFolderName, !granted);
                setBusy(false);
              }}
            >
              Reconnect
            </button>
          )}
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={async () => {
              await forgetModelFolder();
              setModelFolder(undefined);
            }}
          >
            Use browser storage instead
          </button>
        </div>
        <p className="muted small">
          Read from here first, and anything missing is downloaded into it. Nothing else in
          the folder is touched.
        </p>
      </div>
    );
  }

  return (
    <div className="destination">
      <p className="destination__current">Models will be kept in this browser&rsquo;s storage.</p>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const handle = await chooseModelFolder();
          if (handle) setModelFolder(handle, handle.name, false);
          setBusy(false);
        }}
      >
        Choose a folder instead
      </button>
      <p className="muted small">
        Browser storage can be cleared when the machine is short of space. A folder you pick
        keeps the weights where you can see them, and every later run loads from it.
      </p>
    </div>
  );
}
