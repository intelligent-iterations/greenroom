import type { ChatMessage, GenerateOptions, LanguageModel } from '@greenroom/shared';

/**
 * Cloud LLM adapter.
 *
 * Every vendor sits behind one Cloud Function that streams SSE, rather than the
 * browser holding vendor SDKs and keys. Three reasons, in order of importance:
 * keys never reach the client; swapping Azure OpenAI for Gemini is a server
 * deploy rather than an app release; and the audit log of what left the device
 * lives in one place, which is what a residency review actually asks for.
 *
 * This path is off by default and requires explicit opt-in per session.
 */
export interface CloudModelOptions {
  /** Vendor-neutral id resolved server-side, e.g. 'azure-gpt-4o-mini'. */
  model: string;
  endpoint: string;
  /** Firebase ID token supplier. Re-read per request; tokens expire hourly. */
  getAuthToken: () => Promise<string | undefined>;
}

export class CloudLanguageModel implements LanguageModel {
  readonly id: string;
  #options: CloudModelOptions;

  constructor(options: CloudModelOptions) {
    this.#options = options;
    this.id = `cloud:${options.model}`;
  }

  async load(): Promise<void> {
    // Nothing to warm. Kept so the stage is interchangeable with the on-device
    // model, which is the entire point of the interface.
  }

  async *generate(messages: ChatMessage[], options: GenerateOptions = {}): AsyncIterable<string> {
    const token = await this.#options.getAuthToken();
    const response = await fetch(this.#options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: this.#options.model,
        messages,
        temperature: options.temperature ?? 0.6,
        maxTokens: options.maxTokens ?? 160,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Cloud inference failed: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      // SSE frames are separated by a blank line. A chunk boundary can land
      // mid-frame, so only complete frames are consumed and the tail is kept.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload) as { delta?: string; error?: string };
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.delta) yield parsed.delta;
        } catch (err) {
          if (err instanceof SyntaxError) continue; // partial frame, skip
          throw err;
        }
      }
    }
  }
}
