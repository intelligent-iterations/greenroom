/**
 * Whether the browser will keep the model weights, and whether there is room.
 *
 * This module exists because of a bug that looked like a caching bug and was
 * not one. A tester reported that the app re-downloaded 1.6 GB on every visit.
 * The cache code was correct; the machine's disk was at 100%. Chrome's Cache
 * Storage is *best-effort* by default, so under storage pressure the browser
 * evicts whole origin buckets — and it evicts the largest first, which is
 * exactly the bucket holding the weights. The download worked, the cache write
 * worked, and the bytes were gone before the next visit.
 *
 * Nothing in the app said so. That is the actual defect: a 1.6 GB download that
 * silently does not persist, repeated indefinitely, on a metered connection if
 * the person is unlucky. `readiness.ts` says a dead end is fine and an
 * unexplained one is not; this is the same principle applied to storage rather
 * than to the GPU.
 *
 * Two things are therefore done here that the app did not do before:
 *
 *  1. Ask for persistence. A persistent bucket is exempt from automatic
 *     eviction. Chrome grants this on its own engagement heuristics with no
 *     prompt, so the request often fails on a freshly-opened localhost origin —
 *     which is worth reporting rather than hiding, because a denied request is
 *     the difference between "cached" and "cached until the browser needs the
 *     space".
 *  2. Compare the quota the browser is actually offering against what the
 *     download needs, *before* spending the bandwidth.
 *
 * `assessStorage` is pure so every branch is testable without a browser, the
 * same split `capabilities.ts`/`readiness.ts` uses.
 */

export interface StorageProbe {
  /** What the browser will let this origin store, in MB. */
  quotaMb: number;
  /** What it is already storing, in MB. */
  usageMb: number;
  /** Whether the bucket is exempt from automatic eviction. */
  persisted: boolean;
}

export type StorageVerdict =
  /** Room to spare, and the browser has promised not to reclaim it. */
  | { level: 'durable'; headline: string; detail: string }
  /**
   * Room, but the bucket is evictable. The download will work and may not
   * survive. This is the common case on a healthy machine and is not worth
   * alarming anyone about — hence 'note' rather than a warning level.
   */
  | { level: 'evictable'; headline: string; detail: string }
  /** Not enough room. Downloading would fail, or succeed and be reclaimed. */
  | { level: 'insufficient'; headline: string; detail: string; remedies: string[] };

/**
 * Headroom demanded on top of the download itself.
 *
 * Cache Storage writes the response before it can evict anything to make space,
 * and the browser trims the quota as the disk fills, so a quota that exactly
 * equals the download is already a failure. 20% is a guess informed by watching
 * one machine, not a measurement — it is here to be wrong in the safe
 * direction.
 */
const HEADROOM = 1.2;

export async function probeStorage(): Promise<StorageProbe | undefined> {
  const storage = navigator.storage;
  if (!storage?.estimate) return undefined;
  try {
    const { quota = 0, usage = 0 } = await storage.estimate();
    const persisted = storage.persisted ? await storage.persisted() : false;
    return {
      quotaMb: Math.floor(quota / (1024 * 1024)),
      usageMb: Math.floor(usage / (1024 * 1024)),
      persisted,
    };
  } catch {
    // Some privacy configurations refuse to answer. Absent is not the same as
    // zero, so say nothing rather than claim the disk is full.
    return undefined;
  }
}

/**
 * Ask the browser to stop treating this origin as disposable.
 *
 * Returns what is true afterwards, not whether the request was granted — if the
 * bucket was already persistent the request is a no-op and still means yes.
 */
export async function requestPersistence(): Promise<boolean> {
  const storage = navigator.storage;
  if (!storage?.persist) return false;
  try {
    if (storage.persisted && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}

export function assessStorage(
  probe: StorageProbe | undefined,
  neededMb: number,
): StorageVerdict | undefined {
  // No probe means no opinion. Inventing a verdict from a browser that declined
  // to answer would put a scary message in front of someone whose disk is fine.
  if (!probe) return undefined;

  const freeMb = Math.max(0, probe.quotaMb - probe.usageMb);
  const requiredMb = Math.ceil(neededMb * HEADROOM);

  if (freeMb < requiredMb) {
    return {
      level: 'insufficient',
      headline: 'Not enough room to keep the models',
      detail:
        `This download needs about ${gb(neededMb)} and the browser is currently offering ` +
        `${gb(freeMb)} for this site. Browsers shrink that figure as the disk fills, so this ` +
        'usually means the disk itself is nearly full rather than anything about this site.',
      remedies: [
        'Free up disk space — a browser will not hold a large cache on a full disk.',
        'Choose a folder above instead: a folder on disk is a real file the browser never reclaims.',
        'Downloading anyway will work, but the weights will be evicted and fetched again next visit.',
      ],
    };
  }

  if (!probe.persisted) {
    return {
      level: 'evictable',
      headline: 'The models will be cached, but the browser may reclaim them',
      detail:
        `There is room — about ${gb(freeMb)} available. This site does not have persistent ` +
        'storage, so if the disk gets full the browser may clear the weights and the next visit ' +
        'will download them again. Choosing a folder avoids that entirely.',
    };
  }

  return {
    level: 'durable',
    headline: 'The models will be kept',
    detail:
      `About ${gb(freeMb)} available, and this site has persistent storage — the browser will ` +
      'not clear the weights to reclaim space.',
  };
}

function gb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}
