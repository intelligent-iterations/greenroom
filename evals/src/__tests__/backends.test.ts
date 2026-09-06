import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterBackend, makeBackend, ReplayBackend } from '../backends.ts';

/**
 * The reasoning-budget path, which is the one that bit on the first live run.
 *
 * A reasoning model shares `max_tokens` between its deliberation and its
 * answer, so a long think returns an empty string with a perfectly healthy
 * `finish_reason`. Scored naively that is a critical `non_empty` failure and
 * reads as a model that has collapsed, which is the wrong bisect entirely.
 */
function reply(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const starved = {
  choices: [{ finish_reason: 'length', message: { content: '' } }],
  usage: { completion_tokens_details: { reasoning_tokens: 900 } },
};
const answered = {
  choices: [{ finish_reason: 'stop', message: { content: 'What did the latency settle at?' } }],
  usage: { completion_tokens_details: { reasoning_tokens: 40 } },
};

describe('OpenRouterBackend', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    vi.unstubAllGlobals();
  });

  it('names the model in its id, so reports say what was measured', () => {
    expect(new OpenRouterBackend('vendor/model-1').id).toBe('openrouter:vendor/model-1');
  });

  it("grants reasoning headroom on top of the caller's turn budget, not out of it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply(answered));
    vi.stubGlobal('fetch', fetchMock);

    await new OpenRouterBackend('m').complete([{ role: 'user', content: 'hi' }], { maxTokens: 200 });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      max_tokens: number;
      reasoning: unknown;
    };
    expect(body.max_tokens).toBeGreaterThan(200);
    expect(body.reasoning).toEqual({ effort: 'minimal' });
  });

  it('re-asks with a doubled budget when reasoning ate the whole thing', async () => {
    const fetchMock = vi
      .fn(async (_url: string, _init: RequestInit) => reply(answered))
      .mockResolvedValueOnce(reply(starved))
      .mockResolvedValueOnce(reply(answered));
    vi.stubGlobal('fetch', fetchMock);

    const turn = await new OpenRouterBackend('m').complete([{ role: 'user', content: 'hi' }]);

    expect(turn).toBe('What did the latency settle at?');
    const budgetOf = (call: number): number =>
      (JSON.parse(fetchMock.mock.calls[call]![1].body as string) as { max_tokens: number }).max_tokens;
    expect(budgetOf(1)).toBeGreaterThan(budgetOf(0));
  });

  it('fails by name rather than returning an empty turn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(starved)));
    await expect(new OpenRouterBackend('m').complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /spent its whole budget reasoning/,
    );
  });

  // An empty turn with no reasoning spent is the model declining. Re-asking
  // costs money and will not change its mind.
  it('does not retry an empty turn that spent no reasoning', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      reply({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new OpenRouterBackend('m').complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /returned an empty turn/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // OpenRouter reports upstream failures as a 200 with an error body. Treated
  // as a turn, that is an outage scored as a quality regression.
  it('treats a 200 carrying an error body as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: { message: 'upstream is down' } })));
    await expect(new OpenRouterBackend('m').complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /upstream is down/,
    );
  });

  it('refuses to run without a key rather than failing every case', async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(new OpenRouterBackend('m').complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /OPENROUTER_API_KEY/,
    );
  });
});

describe('makeBackend', () => {
  it('builds an openrouter backend by name', () => {
    expect(makeBackend('openrouter', new Map()).id).toContain('openrouter:');
  });

  it('still builds replay, which is what gates every pull request', () => {
    expect(makeBackend('replay', new Map())).toBeInstanceOf(ReplayBackend);
  });

  it('names the valid backends when given an unknown one', () => {
    expect(() => makeBackend('nope', new Map())).toThrow(/replay, azure, gemini or openrouter/);
  });
});
