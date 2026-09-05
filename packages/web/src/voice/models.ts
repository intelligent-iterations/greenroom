import type { ModelDescriptor } from '@greenroom/shared';

/**
 * The model catalogue the router chooses from.
 *
 * The on-device entry is served by transformers.js from the Hugging Face
 * repository named in model-manifest.ts, and `pnpm preflight` verifies every
 * file it will fetch actually resolves before anything is downloaded.
 *
 * We arrived here the hard way. The first choice was Qwen3.5 2B on WebLLM/MLC,
 * guarded by a unit test asserting its id existed in MLC's registry. The test
 * passed and the model could not load: MLC publishes compiled shader libraries
 * and weights as separate artifacts, and for Qwen3.5 and Ministral 3 the
 * weights are missing. Moving the LLM onto transformers.js means the artifact
 * that gets verified is the artifact that gets fetched, and collapses the
 * pipeline onto one runtime and one cache.
 *
 * Model, dtype and device match Hugging Face's `conversational-webgpu` example,
 * a published working in-browser voice chat on this stack.
 *
 * `vramMb` is the measured size of the exact quantised weight file. Latency
 * figures are filled in from `bench.html` on real hardware; see
 * docs/BENCHMARKS.md. `qualityScore` remains a seed value pending a live eval.
 */
export const MODEL_CATALOGUE: ModelDescriptor[] = [
  {
    // Matches the reference implementation exactly. Non-reasoning, which for a
    // voice interviewer is a feature: no think-block latency to suppress and no
    // route by which deliberation reaches the synthesiser.
    id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    vendor: 'on-device',
    label: 'On-device (SmolLM2 1.7B)',
    residency: 'device',
    firstTokenMsP50: 0,
    qualityScore: 0.6,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 1057,
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
