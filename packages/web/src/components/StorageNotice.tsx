import { useEffect, useState } from 'react';
import {
  assessStorage,
  probeStorage,
  requestPersistence,
  type StorageVerdict,
} from '../voice/storage.js';

/**
 * Whether the browser will actually keep what it is about to download.
 *
 * Added after a tester spent several sessions re-downloading 1.6 GB on a full
 * disk. Every layer behaved correctly and none of them said anything: the
 * download succeeded, the cache write succeeded, and the browser quietly
 * reclaimed the bucket before the next visit. The cost of that silence was
 * paid in bandwidth and in trust, repeatedly.
 *
 * So this asks for persistent storage — which is the actual mitigation, not
 * just a warning — and only then reports what is true. Asking first matters:
 * a notice that says "this may be evicted" before trying to prevent eviction
 * is just pessimism.
 */
export function StorageNotice({ neededMb }: { neededMb: number }) {
  const [verdict, setVerdict] = useState<StorageVerdict | undefined>();

  useEffect(() => {
    let live = true;
    void (async () => {
      // Request first, then measure, so `persisted` reflects the answer rather
      // than the state before we asked.
      await requestPersistence();
      const probe = await probeStorage();
      if (live) setVerdict(assessStorage(probe, neededMb));
    })();
    return () => {
      live = false;
    };
  }, [neededMb]);

  // No verdict means the browser declined to estimate. Silence is correct —
  // there is nothing to report and no reason to worry anyone.
  if (!verdict) return null;

  if (verdict.level === 'durable') {
    return <p className="muted small">{verdict.detail}</p>;
  }

  if (verdict.level === 'evictable') {
    return (
      <p className="muted small">
        <strong>{verdict.headline}.</strong> {verdict.detail}
      </p>
    );
  }

  return (
    <div className="notice notice--warn">
      <p>
        <strong>{verdict.headline}.</strong> {verdict.detail}
      </p>
      <ul>
        {verdict.remedies.map((remedy) => (
          <li key={remedy}>{remedy}</li>
        ))}
      </ul>
    </div>
  );
}
