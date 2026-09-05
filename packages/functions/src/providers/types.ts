import type { ChatMessage, Residency } from '@greenroom/shared';

/**
 * Server-side model provider.
 *
 * The browser never holds a vendor SDK or a key. It asks for a model id and
 * gets a token stream; which vendor answers is a server concern. Swapping Azure
 * OpenAI for Gemini is therefore a deploy, not an app release — which matters
 * when the app is embedded in a portal on someone else's release train.
 */
export interface ProviderRequest {
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
}

export interface ModelProvider {
  /** The vendor-neutral id the client asks for. */
  id: string;
  vendor: string;
  /** Where inference happens. Logged per request for residency audit. */
  residency: Residency;
  /** True when the environment holds the credentials this provider needs. */
  isConfigured(): boolean;
  stream(request: ProviderRequest): AsyncIterable<string>;
}

export class ProviderError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/**
 * Reads an SSE body and yields the `data:` payloads.
 *
 * Shared by both providers because both speak SSE, and because getting the
 * chunk-boundary handling right once is worth more than two near-copies: a
 * network chunk routinely splits a frame in half, and a naive line split drops
 * exactly the tokens that straddle it.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
