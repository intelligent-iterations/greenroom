import type { ModelDescriptor } from '@greenroom/shared';

/**
 * The model catalogue the router chooses from, and the menu the learner sees.
 *
 * Several on-device options rather than one, because the right model is a
 * property of the machine as much as of the product: a 260MB model is the
 * difference between working and not on a thin laptop, and a 2.7GB one is the
 * difference between a convincing interviewer and a weak one on a workstation.
 * The router filters by what fits; the learner picks among what is left.
 *
 * Every id is a Hugging Face repository loaded by transformers.js, and every
 * `downloadMb` is measured from the published file sizes — summed across
 * external `_data` shards, which several of these models split their weights
 * into. `pnpm preflight` verifies each file resolves before anyone downloads a
 * gigabyte; it follows the shards, because checking only the graph file would
 * pass a model whose weights are missing.
 *
 * `firstTokenMsP50` is measured only for SmolLM2 1.7B (bench.html, Apple
 * M-series). The others are scaled by parameter count so routing degrades
 * sensibly, and are labelled as estimates until measured.
 */
export const MODEL_CATALOGUE: ModelDescriptor[] = [
  {
    // Default. Measured, and the smallest that holds an interviewer persona at
    // all — the evals put it at 0.73 clean on the interviewer checks.
    id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    vendor: 'on-device',
    label: 'Balanced — SmolLM2 1.7B',
    suitedTo: 'The default. Works on most laptops with graphics acceleration.',
    residency: 'device',
    firstTokenMsP50: 929,
    qualityScore: 0.6,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 1057,
    downloadMb: 1057,
  },
  {
    // Best on-device quality available here. Reasoning-capable, so it leans on
    // the thinking suppression and the <think> stripper in the pipeline.
    id: 'onnx-community/Qwen3-4B-ONNX',
    vendor: 'on-device',
    label: 'Best — Qwen3 4B',
    suitedTo: 'The most capable interviewer that runs locally. Large download.',
    residency: 'device',
    firstTokenMsP50: 1900,
    qualityScore: 0.8,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 2702,
    downloadMb: 2702,
  },
  {
    // The floor. Genuinely weak as an interviewer, and still the difference
    // between practising and not on a constrained machine or a slow connection.
    id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    vendor: 'on-device',
    label: 'Light — SmolLM2 360M',
    suitedTo: 'Small download, modest hardware. The interviewer is noticeably weaker.',
    residency: 'device',
    firstTokenMsP50: 400,
    qualityScore: 0.3,
    costPerSessionUsd: 0,
    offlineCapable: true,
    requiresWebGpu: true,
    vramMb: 260,
    downloadMb: 260,
  },
  {
    id: 'azure-gpt-4o-mini',
    vendor: 'azure-openai',
    label: 'Azure OpenAI (Canada Central)',
    suitedTo: 'Strongest interviewer. Your answers leave the device.',
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
    suitedTo: 'Strongest interviewer. Your answers leave the device.',
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

/** On-device options that fit the given GPU memory budget, best first. */
export function affordableModels(budgetMb: number | undefined): ModelDescriptor[] {
  return MODEL_CATALOGUE.filter(
    (m) => m.vendor === 'on-device' && (budgetMb === undefined || (m.vramMb ?? 0) <= budgetMb),
  ).sort((a, b) => b.qualityScore - a.qualityScore);
}
