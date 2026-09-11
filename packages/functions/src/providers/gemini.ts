import type { ChatMessage } from '@greenroom/shared';
import { ProviderError, readSseData, type ModelProvider, type ProviderRequest } from './types.js';

/**
 * Google Gemini.
 *
 * Kept as a live second route rather than a diagram: the value of portability
 * is only real if the alternative is exercised, so the benchmark job in CI runs
 * the same eval set through both providers and the results land in
 * docs/BENCHMARKS.md.
 */
export class GeminiProvider implements ModelProvider {
  readonly id: string;
  readonly vendor = 'google-gemini';
  readonly residency = 'us-region' as const;
  #model: string;

  constructor(id: string, model: string) {
    this.id = id;
    this.#model = model;
  }

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_API_KEY);
  }

  async *stream(request: ProviderRequest): AsyncIterable<string> {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new ProviderError('Gemini is not configured', 503);

    // Gemini takes the system prompt as a separate field and uses
    // 'model' where OpenAI uses 'assistant'. Normalising here rather than in
    // the caller is what keeps the two providers interchangeable upstream.
    const system = request.messages.filter((m) => m.role === 'system');
    const turns = request.messages.filter((m: ChatMessage) => m.role !== 'system');

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.#model}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(system.length > 0
          ? { systemInstruction: { parts: system.map((m) => ({ text: m.content })) } }
          : {}),
        contents: turns.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
        },
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(`Gemini returned ${response.status}`, response.status);
    }

    for await (const payload of readSseData(response.body)) {
      try {
        const parsed = JSON.parse(payload) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        for (const part of parsed.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) yield part.text;
        }
      } catch {
        // Partial or keepalive frame.
      }
    }
  }
}
