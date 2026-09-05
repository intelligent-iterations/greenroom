import type { ModelDescriptor } from '@greenroom/shared';

/**
 * The model catalogue the router chooses from.
 *
 * IMPORTANT: the latency and quality figures below are SEED VALUES, not
 * measurements. They encode the ordering the design assumes — on-device is
 * fastest to first token and weakest on instruction-following, hosted models
 * are the reverse — so that routing behaves sensibly before anyone has
 * benchmarked anything. They are checked in rather than hidden in config
 * precisely so they are reviewable, and so replacing them with real numbers is
 * a visible diff.
 *
 * Replace them by running the benchmark described in docs/BENCHMARKS.md on
 * target hardware. Until that has been done, treat the ordering as intentional
 * and the absolute values as unverified.
 *
 * Adding a vendor is: add a descriptor here, add an adapter implementing
 * LanguageModel, map the id server-side. Nothing else in the app changes.
 */
export const MODEL_CATALOGUE: ModelDescriptor[] = [
  {
    id: 'Qwen3-1.7B-q4f16_1-MLC',
    vendor: 'on-device',
    label: 'On-device (Qwen3 1.7B)',
    residency: 'device',
    firstTokenMsP50: 420,
    qualityScore: 0.62,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    vendor: 'on-device',
    label: 'On-device (Llama 3.2 1B)',
    residency: 'device',
    firstTokenMsP50: 310,
    // Seeded below Qwen3: it is the smaller model, and it exists here as the
    // option for constrained machines where the 1.7B weights would not fit
    // alongside Whisper and Kokoro.
    qualityScore: 0.54,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
  },
  {
    id: 'azure-gpt-4o-mini',
    vendor: 'azure-openai',
    label: 'Azure OpenAI (Canada Central)',
    residency: 'ca-region',
    firstTokenMsP50: 610,
    qualityScore: 0.86,
    costPerSessionUsd: 0.014,
    offlineCapable: false,
  },
  {
    id: 'gemini-3-flash',
    vendor: 'google-gemini',
    label: 'Google Gemini Flash',
    residency: 'us-region',
    firstTokenMsP50: 380,
    qualityScore: 0.88,
    costPerSessionUsd: 0.009,
    offlineCapable: false,
  },
];

export function findModel(id: string): ModelDescriptor | undefined {
  return MODEL_CATALOGUE.find((m) => m.id === id);
}
