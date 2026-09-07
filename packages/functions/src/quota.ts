/**
 * Spend limits for the cloud inference path.
 *
 * The threat is specific and it is not sophisticated. Anonymous auth is enabled
 * on purpose — the product does not require an identity to practise — which
 * means a Firebase ID token proves that a browser loaded the page and nothing
 * more. Anyone can mint as many uids as they like, for free, in a loop.
 *
 * So a per-user cap on its own bounds nothing at all. It is here because it
 * stops one honest runaway client, and because it makes the audit log legible.
 * **The global cap is the one that actually bounds the bill**, and it is the
 * reason this file exists.
 *
 * Per-request caps in generate.ts already bound the cost of one call
 * (`maxTokens` at most 1024). These bound the number of calls. Both are needed:
 * one small request repeated ten thousand times is the same invoice as ten
 * thousand large ones.
 */

/** Minimal surface of the Firestore admin client, so this is testable. */
export interface QuotaStore {
  runTransaction<T>(fn: (tx: QuotaTransaction) => Promise<T>): Promise<T>;
  doc(path: string): QuotaRef;
}

export interface QuotaRef {
  readonly path: string;
}

export interface QuotaTransaction {
  get(ref: QuotaRef): Promise<{ data(): { count?: number } | undefined }>;
  set(ref: QuotaRef, data: { count: number; updatedAt: number }): void;
}

export interface QuotaLimits {
  /** Cloud turns one uid may spend per UTC day. */
  perUserDaily: number;
  /** Cloud turns the whole deployment may spend per UTC day. */
  globalDaily: number;
}

/**
 * Deliberately small defaults.
 *
 * A demo deployment should cost pocket money even if it is found and hammered.
 * Raising these is a conscious act with a number attached, which is the point —
 * the previous state had no number at all, and "no limit" is not a decision
 * anybody makes on purpose.
 */
export const DEFAULT_LIMITS: QuotaLimits = { perUserDaily: 50, globalDaily: 500 };

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): QuotaLimits {
  const read = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    // A typo must not silently disable the cap it was meant to set.
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  };
  return {
    perUserDaily: read('QUOTA_PER_USER_DAILY', DEFAULT_LIMITS.perUserDaily),
    globalDaily: read('QUOTA_GLOBAL_DAILY', DEFAULT_LIMITS.globalDaily),
  };
}

export interface QuotaDecision {
  allowed: boolean;
  /** Set when denied, and safe to show a user. */
  reason?: string;
  /** Which ceiling was hit, for the log. Never shown to the client. */
  scope?: 'user' | 'global';
}

/** UTC day key. Deliberately not local time: the bill is not in anyone's timezone. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Count one cloud turn against both ceilings, atomically.
 *
 * Reserved *before* the vendor call rather than recorded after it. A request
 * that is counted only on success lets a client that always disconnects early
 * spend without ever being counted.
 */
export async function reserveTurn(
  store: QuotaStore,
  uid: string,
  limits: QuotaLimits = limitsFromEnv(),
  now: number = Date.now(),
): Promise<QuotaDecision> {
  const day = dayKey(now);
  const globalRef = store.doc(`quota/global-${day}`);
  const userRef = store.doc(`quota/user-${uid}-${day}`);

  try {
    return await store.runTransaction(async (tx) => {
      // Both reads must precede both writes: Firestore transactions require it.
      const [globalSnap, userSnap] = [await tx.get(globalRef), await tx.get(userRef)];
      const globalCount = globalSnap.data()?.count ?? 0;
      const userCount = userSnap.data()?.count ?? 0;

      if (globalCount >= limits.globalDaily) {
        return {
          allowed: false,
          scope: 'global' as const,
          reason: 'This deployment has reached its daily cloud budget. Try the on-device model.',
        };
      }
      if (userCount >= limits.perUserDaily) {
        return {
          allowed: false,
          scope: 'user' as const,
          reason: 'Daily limit reached for this session. Try the on-device model.',
        };
      }

      tx.set(globalRef, { count: globalCount + 1, updatedAt: now });
      tx.set(userRef, { count: userCount + 1, updatedAt: now });
      return { allowed: true };
    });
  } catch (err) {
    // Fail closed. If the counter cannot be read, the ceiling cannot be
    // honoured, and an unbounded spend is a worse outcome than an unavailable
    // feature — especially for a feature that is opt-in and has an on-device
    // alternative one click away.
    console.error('quota check failed; denying', err);
    return {
      allowed: false,
      scope: 'global',
      reason: 'Cloud inference is temporarily unavailable. The on-device model still works.',
    };
  }
}
