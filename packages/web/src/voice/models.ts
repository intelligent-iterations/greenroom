import type { ModelDescriptor } from '@greenroom/shared';

/**
 * The model catalogue the router chooses from.
 *
 * Every on-device id here is verified against WebLLM's own `prebuiltAppConfig`
 * at the pinned version, and `vramMb` is copied from that record rather than
 * estimated. A model id that is not in the prebuilt list cannot be loaded in a
 * browser at all — MLC has to compile weights to WebGPU shader libraries first —
 * so "best small model" is always constrained to "best small model MLC has
 * compiled". As of this pin that rules out Gemma 4, which is otherwise a strong
 * candidate in this size class.
 *
 * `firstTokenMsP50` and `qualityScore` remain SEED VALUES, not measurements —
 * see docs/BENCHMARKS.md. Their *ordering* is grounded: within the Qwen3.5
 * family it follows the published intelligence ranking (0.8B < 2B < 4B) and the
 * parameter count, so routing degrades sensibly. The absolute numbers are not
 * evidence of anything until the benchmark has been run on target hardware.
 *
 * A note that matters more than model choice: every Qwen3.5 variant is a
 * reasoning model. Left alone it will think before answering, which for a
 * spoken interviewer means seconds of silence and then, if any of it escapes,
 * the learner hearing the model's private deliberation read aloud. The adapter
 * disables thinking and filters the stream; see llm-webllm.ts.
 */
export const MODEL_CATALOGUE: ModelDescriptor[] = [
  {
    // The realtime default. Qwen3.5's small series targets edge inference
    // explicitly, and 2B is the smallest variant we would trust to hold a
    // detailed system prompt — the interviewer has to stay in role, withhold
    // answers and pitch difficulty, all of which are instruction-following.
    id: 'Qwen3.5-2B-q4f16_1-MLC',
    vendor: 'on-device',
    label: 'On-device (Qwen3.5 2B)',
    residency: 'device',
    firstTokenMsP50: 380,
    qualityScore: 0.7,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 2246,
  },
  {
    // Fastest option, and the fallback when memory is tight. Materially weaker
    // at instruction-following, so it is chosen on constraint rather than
    // preference: a session on a small machine beats no session.
    id: 'Qwen3.5-0.8B-q4f16_1-MLC',
    vendor: 'on-device',
    label: 'On-device (Qwen3.5 0.8B)',
    residency: 'device',
    firstTokenMsP50: 260,
    qualityScore: 0.52,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 1630,
  },
  {
    // Best on-device quality available here, at nearly 4GB. Reachable only on a
    // discrete GPU once the recogniser and voice have taken their share.
    id: 'Qwen3.5-4B-q4f16_1-MLC',
    vendor: 'on-device',
    label: 'On-device (Qwen3.5 4B)',
    residency: 'device',
    firstTokenMsP50: 620,
    qualityScore: 0.79,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 3868,
  },
  {
    // Non-reasoning, and the smallest thing that still holds a persona. Kept as
    // the floor for very constrained devices and as a control when diagnosing
    // whether a problem is Qwen3.5's reasoning behaviour or the prompt.
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    vendor: 'on-device',
    label: 'On-device (Llama 3.2 1B)',
    residency: 'device',
    firstTokenMsP50: 240,
    qualityScore: 0.45,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 879,
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
