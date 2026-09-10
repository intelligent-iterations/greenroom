import { describe, expect, it } from 'vitest';
import { assessStorage, type StorageProbe } from '../storage.js';

const probe = (over: Partial<StorageProbe> = {}): StorageProbe => ({
  quotaMb: 20_000,
  usageMb: 0,
  persisted: true,
  ...over,
});

describe('assessStorage', () => {
  it('says nothing when the browser declined to estimate', () => {
    // The failure this guards: inventing "your disk is full" from an absent
    // measurement, in front of someone whose disk is fine.
    expect(assessStorage(undefined, 1600)).toBeUndefined();
  });

  it('is durable with room and a persistent bucket', () => {
    expect(assessStorage(probe(), 1600)?.level).toBe('durable');
  });

  it('is evictable with room but no persistence', () => {
    // The common case, and the one that produced the original bug report: the
    // download works and does not survive.
    const verdict = assessStorage(probe({ persisted: false }), 1600);
    expect(verdict?.level).toBe('evictable');
  });

  it('is insufficient when the quota cannot hold the download', () => {
    const verdict = assessStorage(probe({ quotaMb: 900 }), 1600);
    expect(verdict?.level).toBe('insufficient');
  });

  it('counts existing usage against the quota', () => {
    // 20 GB quota is ample; 19.5 GB of it already spent is not. Reading quota
    // alone is the easy way to get this wrong.
    const verdict = assessStorage(probe({ quotaMb: 20_000, usageMb: 19_500 }), 1600);
    expect(verdict?.level).toBe('insufficient');
  });

  it('demands headroom above the download size', () => {
    // Exactly enough is not enough: the cache writes before it can evict, and
    // browsers trim the quota as the disk fills.
    expect(assessStorage(probe({ quotaMb: 1600 }), 1600)?.level).toBe('insufficient');
    expect(assessStorage(probe({ quotaMb: 1920 }), 1600)?.level).toBe('durable');
  });

  it('never reports negative free space', () => {
    // Reported usage can exceed quota after the browser trims it, and
    // "-4000 MB available" in the UI would read as a bug in the app.
    const verdict = assessStorage(probe({ quotaMb: 1000, usageMb: 5000 }), 1600);
    expect(verdict?.level).toBe('insufficient');
    expect(verdict && 'detail' in verdict ? verdict.detail : '').not.toMatch(/-/);
  });

  it('tells someone what to do when there is no room', () => {
    const verdict = assessStorage(probe({ quotaMb: 100 }), 1600);
    expect(verdict?.level).toBe('insufficient');
    expect(verdict && 'remedies' in verdict ? verdict.remedies : []).not.toHaveLength(0);
    // The folder path is the durable answer, so it must be offered here.
    expect(
      verdict && 'remedies' in verdict ? verdict.remedies.some((r) => /folder/i.test(r)) : false,
    ).toBe(true);
  });
});
