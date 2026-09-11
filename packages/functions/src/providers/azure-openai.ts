import { ProviderError, readSseData, type ModelProvider, type ProviderRequest } from './types.js';

/**
 * Azure OpenAI.
 *
 * The Canada Central deployment is the one that clears federal residency review
 * without a separate assessment, so it is the default cloud route despite
 * Gemini scoring marginally higher on our rubric. Residency outranks quality
 * here; see docs/adr/0003-model-portability.md.
 */
export class AzureOpenAiProvider implements ModelProvider {
  readonly id: string;
  readonly vendor = 'azure-openai';
  readonly residency = 'ca-region' as const;
  #deployment: string;

  constructor(id: string, deployment: string) {
    this.id = id;
    this.#deployment = deployment;
  }

  isConfigured(): boolean {
    return Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY);
  }

  async *stream(request: ProviderRequest): AsyncIterable<string> {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '');
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';
    if (!endpoint || !apiKey) throw new ProviderError('Azure OpenAI is not configured', 503);

    const url = `${endpoint}/openai/deployments/${this.#deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      throw new ProviderError(`Azure OpenAI returned ${response.status}`, response.status);
    }

    for await (const payload of readSseData(response.body)) {
      if (payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // Azure occasionally emits an empty keepalive frame. Skip, do not fail.
      }
    }
  }
}
