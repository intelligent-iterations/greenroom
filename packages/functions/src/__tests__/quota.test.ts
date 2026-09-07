import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIMITS,
  dayKey,
  limitsFromEnv,
  reserveTurn,
  type QuotaRef,
  type QuotaStore,
} from '../quota.js';

/** An in-memory stand-in for the admin Firestore client. */
function storeOf(seed: Record<string, number> = {}) {
  const docs = new Map<string, number>(Object.entries(seed));
  const store: QuotaStore & { docs: Map<string, number>; transactions: number } = {
    docs,
    transactions: 0,
    doc: (path: string): QuotaRef => ({ path }),
    async runTransaction(fn) {
      store.transactions += 1;
      return fn({
        async get(ref) {
          const count = docs.get(ref.path);
          return { data: () => (count === undefined ? undefined : { count }) };
        },
        set(ref, data) {
          docs.set(ref.path, data.count);
        },
      });
    },
  };
  return store;
}

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const DAY = dayKey(NOW);

describe('reserveTurn', () => {
  it('allows a first turn and counts it against both ceilings', async () => {
    const store = storeOf();
    expect((await reserveTurn(store, 'u1', DEFAULT_LIMITS, NOW)).allowed).toBe(true);
    expect(store.docs.get(`quota/global-${DAY}`)).toBe(1);
    expect(store.docs.get(`quota/user-u1-${DAY}`)).toBe(1);
  });

  it('stops one user at their own ceiling', async () => {
    const store = storeOf({ [`quota/user-u1-${DAY}`]: 5 });
    const decision = await reserveTurn(store, 'u1', { perUserDaily: 5, globalDaily: 100 }, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.scope).toBe('user');
  });

  /**
   * The case the whole file exists for. Anonymous auth means uids are free, so
   * a per-user cap alone bounds nothing: a hundred fresh uids each under their
   * own limit still empty the account. Only the global ceiling stops it.
   */
  it('stops a crowd of fresh uids that are each individually under the limit', async () => {
    const store = storeOf();
    const limits = { perUserDaily: 50, globalDaily: 10 };
    const results = [];
    for (let i = 0; i < 12; i += 1) {
      results.push(await reserveTurn(store, `anon-${i}`, limits, NOW));
    }
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.at(-1)?.scope).toBe('global');
  });

  it('does not count a turn it refused', async () => {
    const store = storeOf({ [`quota/global-${DAY}`]: 10 });
    await reserveTurn(store, 'u1', { perUserDaily: 50, globalDaily: 10 }, NOW);
    expect(store.docs.get(`quota/global-${DAY}`)).toBe(10);
  });

  it('starts a fresh ceiling on the next UTC day', async () => {
    const store = storeOf({ [`quota/global-${DAY}`]: 500 });
    const tomorrow = NOW + 24 * 60 * 60 * 1000;
    expect((await reserveTurn(store, 'u1', DEFAULT_LIMITS, tomorrow)).allowed).toBe(true);
  });

  /**
   * Fail closed. A counter that cannot be read cannot honour a ceiling, and an
   * unbounded spend is worse than an unavailable feature — especially one that
   * is opt-in with an on-device alternative a click away.
   */
  it('denies when the counter is unreadable rather than letting the call through', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: QuotaStore = {
      doc: (path) => ({ path }),
      async runTransaction() {
        throw new Error('firestore unavailable');
      },
    };
    expect((await reserveTurn(broken, 'u1', DEFAULT_LIMITS, NOW)).allowed).toBe(false);
    vi.restoreAllMocks();
  });

  it('gives a denial reason that points at the on-device path', async () => {
    const store = storeOf({ [`quota/global-${DAY}`]: 1 });
    const decision = await reserveTurn(store, 'u1', { perUserDaily: 50, globalDaily: 1 }, NOW);
    expect(decision.reason).toMatch(/on-device/);
  });
});

describe('limitsFromEnv', () => {
  it('is capped by default, not unlimited', () => {
    expect(limitsFromEnv({})).toEqual(DEFAULT_LIMITS);
  });

  it('reads an explicit override', () => {
    expect(limitsFromEnv({ QUOTA_GLOBAL_DAILY: '25' }).globalDaily).toBe(25);
  });

  it('allows an explicit zero, which is a real choice', () => {
    expect(limitsFromEnv({ QUOTA_GLOBAL_DAILY: '0' }).globalDaily).toBe(0);
  });

  // A typo must not silently remove the ceiling it was meant to set.
  it('falls back to the default on a malformed value', () => {
    expect(limitsFromEnv({ QUOTA_GLOBAL_DAILY: 'lots' }).globalDaily).toBe(DEFAULT_LIMITS.globalDaily);
    expect(limitsFromEnv({ QUOTA_PER_USER_DAILY: '-5' }).perUserDaily).toBe(DEFAULT_LIMITS.perUserDaily);
  });
});
