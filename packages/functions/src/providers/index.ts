import { AzureOpenAiProvider } from './azure-openai.js';
import { GeminiProvider } from './gemini.js';
import type { ModelProvider } from './types.js';

/**
 * The provider registry.
 *
 * Client-facing ids are vendor-neutral and stable; which vendor and which
 * deployment answers them is configuration. That indirection is the portability
 * the architecture claims: repointing 'azure-gpt-4o-mini' at a different
 * deployment, or at Gemini entirely, changes nothing the client ships.
 */
const PROVIDERS: ModelProvider[] = [
  new AzureOpenAiProvider(
    'azure-gpt-4o-mini',
    process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4o-mini',
  ),
  new GeminiProvider('gemini-3-flash', 'gemini-3-flash'),
  new GeminiProvider('gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'),
];

export function findProvider(id: string): ModelProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * The provider used for server-side scoring.
 *
 * Falls through the list in order, so a deployment that only configures Gemini
 * still scores sessions rather than silently leaving mastery estimates frozen —
 * a failure that would be invisible until a learner's difficulty stopped
 * adapting weeks later.
 */
export function defaultScoringProvider(): ModelProvider | undefined {
  return PROVIDERS.find((p) => p.isConfigured());
}

export function configuredProviderIds(): string[] {
  return PROVIDERS.filter((p) => p.isConfigured()).map((p) => p.id);
}
