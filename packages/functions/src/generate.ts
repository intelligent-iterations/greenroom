import { z } from 'zod';
import { findProvider } from './providers/index.js';
import { ProviderError } from './providers/types.js';
import type { Request } from 'firebase-functions/https';
// firebase-functions types the response as Express's own, which is what gives
// us `flushHeaders` and the raw `write` that SSE needs.
import type { Response } from 'express';
import { verifyRequest } from './auth.js';

/**
 * Body schema.
 *
 * Caps are enforced here rather than trusted from the client. `maxTokens` in
 * particular: an interviewer turn is under 60 spoken words, so a request for
 * 8000 tokens is either a bug or someone using our billing account as a free
 * LLM endpoint. Both are worth rejecting.
 */
const GenerateBody = z.object({
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
});

/**
 * Streams model output to the browser as SSE.
 *
 * SSE rather than a WebSocket because the traffic is one-directional and short
 * lived, and SSE survives the proxies in front of a corporate portal that
 * routinely break WebSocket upgrades.
 */
export async function handleGenerate(req: Request, res: Response): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
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
