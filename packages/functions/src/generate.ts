import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { findProvider } from './providers/index.js';
import { ProviderError } from './providers/types.js';
import type { Request } from 'firebase-functions/https';
// firebase-functions types the response as Express's own, which is what gives
// us `flushHeaders` and the raw `write` that SSE needs.
import type { Response } from 'express';
import { verifyRequest } from './auth.js';
import { reserveTurn, type QuotaStore } from './quota.js';

/**
 * Body schema.
 *
 * Caps are enforced here rather than trusted from the client. `maxTokens` in
 * particular: an interviewer turn is under 60 spoken words, so a request for
 * 8000 tokens is either a bug or someone using our billing account as a free
 * LLM endpoint. Both are worth rejecting.
 */
/**
 * Total characters across all messages in one request.
 *
 * The per-message and per-array caps below bound the *shape* of a request but
 * not its size: sixty messages of eight thousand characters is 480,000
 * characters, roughly 120,000 input tokens, in a single call. Multiplied by a
 * daily ceiling counted in turns, that is a four-figure monthly bill from a
 * quota that looks bounded.
 *
 * So size is capped as well as count, and the two together are what make the
 * ceiling in quota.ts mean something in dollars. 24,000 characters is about
 * 6,000 tokens — comfortably more than double a real session, which is a
 * compiled prompt of roughly 2,700 characters plus a transcript that is short
 * by construction because every spoken turn is under sixty words.
 */
const MAX_REQUEST_CHARS = 24_000;

const GenerateBody = z
  .object({
    model: z.string().min(1).max(64),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant']),
          content: z.string().max(8000),
        }),
      )
      .min(1)
      .max(60),
    temperature: z.number().min(0).max(2).default(0.6),
    maxTokens: z.number().int().min(1).max(1024).default(160),
  })
  .refine(
    (body) => body.messages.reduce((total, m) => total + m.content.length, 0) <= MAX_REQUEST_CHARS,
    { message: `Total message content must be at most ${MAX_REQUEST_CHARS} characters` },
  );

/**
 * Streams model output to the browser as SSE.
 *
 * SSE rather than a WebSocket because the traffic is one-directional and short
 * lived, and SSE survives the proxies in front of a corporate portal that
 * routinely break WebSocket upgrades.
 */
/**
 * Whether this deployment serves cloud inference at all.
 *
 * A key being present is NOT consent. The two are separated deliberately: a
 * vendor key can arrive in an environment for a dozen reasons — a shared
 * secret store, a copied config, someone testing the scoring trigger — and none
 * of them should quietly turn a public endpoint into a billable LLM API. So
 * enabling costs two deliberate acts rather than one accidental one.
 *
 * Off by default, which is the right posture for the public demo and for anyone
 * who clones this: the on-device path is the product, and a self-hoster who
 * wants the cloud route sets their own key and owns their own bill.
 */
export function cloudInferenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLOUD_INFERENCE_ENABLED === 'true';
}

export async function handleGenerate(
  req: Request,
  res: Response,
  // Injected so the endpoint's ordering can be tested without Firestore. The
  // ordering is the security property: auth, then quota, then vendor.
  store: QuotaStore = getFirestore() as unknown as QuotaStore,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Checked before authentication, so a disabled deployment does not even do
  // token-verification work on request. The posture is public information —
  // the README states it — so there is nothing to withhold here.
  if (!cloudInferenceEnabled()) {
    res.status(503).json({ error: 'Cloud inference is disabled on this deployment' });
    return;
  }

  const user = await verifyRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }

  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', detail: parsed.error.issues });
    return;
  }

  // Counted before the vendor is touched, and before the provider is even
  // resolved, so a caller cannot spend anything by probing model ids. Anonymous
  // uids are free to mint, so the global ceiling inside is the one doing the
  // real work — see quota.ts.
  const quota = await reserveTurn(store, user.uid);
  if (!quota.allowed) {
    console.warn(JSON.stringify({ event: 'quota_denied', uid: user.uid, scope: quota.scope }));
    res.status(429).json({ error: quota.reason });
    return;
  }

  const provider = findProvider(parsed.data.model);
  if (!provider) {
    res.status(404).json({ error: `Unknown model: ${parsed.data.model}` });
    return;
  }
  if (!provider.isConfigured()) {
    res.status(503).json({ error: `${provider.id} is not configured on this deployment` });
    return;
  }

  // One line per cloud inference, with where it went. This is the artefact a
  // residency review asks for, and the reason cloud calls are funnelled through
  // one endpoint instead of made from the browser.
  console.info(
    JSON.stringify({
      event: 'cloud_inference',
      uid: user.uid,
      model: provider.id,
      vendor: provider.vendor,
      residency: provider.residency,
      turns: parsed.data.messages.length,
    }),
  );

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // A learner who hangs up mid-turn should stop the vendor call, not leave it
  // billing until it finishes talking to nobody.
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    for await (const delta of provider.stream({
      messages: parsed.data.messages,
      temperature: parsed.data.temperature,
      maxTokens: parsed.data.maxTokens,
      signal: abort.signal,
    })) {
      if (abort.signal.aborted) break;
      res.write(`data: ${JSON.stringify({ delta })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    if (abort.signal.aborted) return;
    const message = err instanceof ProviderError ? err.message : 'Inference failed';
    console.error('generate failed', err);
    // Headers are already sent, so the error has to travel in-band.
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  } finally {
    res.end();
  }
}
