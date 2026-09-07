import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaStore } from '../quota.js';

vi.mock('../auth.js', () => ({
  verifyRequest: vi.fn(async (req: { get: (h: string) => string | undefined }) =>
    req.get('authorization') ? { uid: 'u1' } : undefined,
  ),
}));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({}) }));

const { handleGenerate } = await import('../generate.js');

/**
 * The ordering in this endpoint is the security property, not an
 * implementation detail: auth, then quota, then vendor. A quota check that runs
 * after the vendor call bounds nothing, and one that runs after the provider is
 * resolved lets a caller spend by probing model ids.
 */
function reqOf(body: unknown, authed = true, method = 'POST') {
  return {
    method,
    body,
    get: (h: string) => (h === 'authorization' && authed ? 'Bearer token' : undefined),
    on: () => {},
  } as never;
}

function resOf() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    written: [] as string[],
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    flushHeaders() {},
    write(chunk: string) {
      res.written.push(chunk);
    },
    end() {},
  };
  return res;
}

const VALID = { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hi' }] };

function storeThat(allow: boolean): QuotaStore & { consulted: number } {
  const store = {
    consulted: 0,
    doc: (path: string) => ({ path }),
    async runTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      store.consulted += 1;
      return fn({
        async get() {
          return { data: () => ({ count: allow ? 0 : 10_000 }) };
        },
        set() {},
      } as never);
    },
  };
  return store as QuotaStore & { consulted: number };
}

beforeEach(() => {
  delete process.env.GOOGLE_API_KEY;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
});

describe('handleGenerate gate ordering', () => {
  it('rejects a non-POST before anything else', async () => {
    const res = resOf();
    const store = storeThat(true);
    await handleGenerate(reqOf(VALID, true, 'GET'), res as never, store);
    expect(res.statusCode).toBe(405);
    expect(store.consulted).toBe(0);
  });

  it('rejects an unauthenticated request without consulting quota', async () => {
    const res = resOf();
    const store = storeThat(true);
    await handleGenerate(reqOf(VALID, false), res as never, store);
    expect(res.statusCode).toBe(401);
    expect(store.consulted).toBe(0);
  });

  it('returns 429 when the ceiling is reached', async () => {
    const res = resOf();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleGenerate(reqOf(VALID), res as never, storeThat(false));
    expect(res.statusCode).toBe(429);
    vi.restoreAllMocks();
  });

  // A caller must not be able to spend, or probe which vendors exist, by
  // sending model ids until one sticks.
  it('counts the turn before the model id is even resolved', async () => {
    const res = resOf();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = storeThat(false);
    await handleGenerate(reqOf({ ...VALID, model: 'does-not-exist' }), res as never, store);
    expect(store.consulted).toBe(1);
    expect(res.statusCode).toBe(429);
    vi.restoreAllMocks();
  });

  /**
   * The property that makes today's deployment safe: with no vendor key
   * configured, the endpoint cannot spend anything. Asserted rather than
   * assumed, because it currently holds by accident — nobody has set a key —
   * and an accident is not a control.
   */
  it('cannot reach a vendor when no key is configured', async () => {
    const res = resOf();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await handleGenerate(reqOf(VALID), res as never, storeThat(true));
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not configured') });
    vi.restoreAllMocks();
  });

  it('rejects an oversized token request rather than trusting the client', async () => {
    const res = resOf();
    await handleGenerate(reqOf({ ...VALID, maxTokens: 8000 }), res as never, storeThat(true));
    expect(res.statusCode).toBe(400);
  });
});
