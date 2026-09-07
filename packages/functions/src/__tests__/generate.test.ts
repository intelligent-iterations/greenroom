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
  // Every test below runs with the deployment enabled unless it says otherwise;
  // the disabled case is the default posture and is asserted separately.
  process.env.CLOUD_INFERENCE_ENABLED = 'true';
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

  /**
   * Counting turns bounds nothing on its own: the shape caps allowed 60x8000
   * characters in one call, about 120k input tokens, so a ceiling of 500 turns
   * a day was really a ceiling of 60M tokens a day.
   */
  it('rejects a request that is within the shape caps but enormous', async () => {
    const res = resOf();
    const huge = Array.from({ length: 60 }, () => ({ role: 'user', content: 'x'.repeat(8000) }));
    await handleGenerate(reqOf({ ...VALID, messages: huge }), res as never, storeThat(true));
    expect(res.statusCode).toBe(400);
  });

  it('still accepts a realistically sized session', async () => {
    const res = resOf();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const real = [
      { role: 'system', content: 'x'.repeat(2700) },
      ...Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(600) })),
    ];
    await handleGenerate(reqOf({ ...VALID, messages: real }), res as never, storeThat(true));
    // 503 = it got all the way to the provider and found no key configured.
    expect(res.statusCode).toBe(503);
    vi.restoreAllMocks();
  });

  it('rejects an oversized token request rather than trusting the client', async () => {
    const res = resOf();
    await handleGenerate(reqOf({ ...VALID, maxTokens: 8000 }), res as never, storeThat(true));
    expect(res.statusCode).toBe(400);
  });
});

describe('deployment posture', () => {
  /**
   * The property that makes the public demo safe by design rather than by
   * nobody having set a key yet. A key can arrive in an environment for a dozen
   * innocent reasons; none of them should turn a public endpoint into a
   * billable LLM API.
   */
  it('is disabled by default, even with a vendor key present', async () => {
    delete process.env.CLOUD_INFERENCE_ENABLED;
    process.env.GOOGLE_API_KEY = 'a-real-looking-key';
    const res = resOf();
    const store = storeThat(true);

    await handleGenerate(reqOf(VALID), res as never, store);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining('disabled') });
    // Nothing was spent and nothing was counted.
    expect(store.consulted).toBe(0);
    delete process.env.GOOGLE_API_KEY;
  });

  it('treats anything other than the exact opt-in string as off', async () => {
    for (const value of ['1', 'yes', 'TRUE', '']) {
      process.env.CLOUD_INFERENCE_ENABLED = value;
      const res = resOf();
      await handleGenerate(reqOf(VALID), res as never, storeThat(true));
      expect(res.statusCode).toBe(503);
    }
  });

  // Refused before a token is even verified, so a disabled deployment does no
  // work on request.
  it('refuses without verifying the caller', async () => {
    delete process.env.CLOUD_INFERENCE_ENABLED;
    const res = resOf();
    await handleGenerate(reqOf(VALID, false), res as never, storeThat(true));
    expect(res.statusCode).toBe(503);
  });
});
