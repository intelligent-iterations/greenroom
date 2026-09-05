/**
 * Model routing and portability.
 *
 * The product must be able to move between an on-device model, Azure OpenAI,
 * Google Gemini and a specialist voice vendor without the pipeline knowing. The
 * mechanism is: every backend publishes a ModelDescriptor, and a pure policy
 * function picks one. Adding a vendor means adding a descriptor and an adapter
 * implementing LanguageModel — no orchestrator change.
 *
 * Benchmark numbers behind the descriptors live in docs/BENCHMARKS.md.
 */

/**
 * Where inference physically happens. This is a compliance axis, not a
 * performance one: for a Canadian federal deployment, 'device' and 'ca-region'
 * are the only values that clear residency review without a separate
 * assessment, and that constraint outranks quality.
 */
export type Residency = 'device' | 'ca-region' | 'us-region' | 'unspecified';

/** Only vendors with a working adapter. Adding one here without an adapter
 *  would let the router select a model nothing can serve. */
export type Vendor = 'on-device' | 'azure-openai' | 'google-gemini';

export interface ModelDescriptor {
  id: string;
  vendor: Vendor;
  /** Human label for the UI. */
  label: string;
  residency: Residency;
  /**
   * Median first-token latency in ms. Populated from the benchmark in
   * docs/BENCHMARKS.md; seeded with design assumptions until that has run.
   */
  firstTokenMsP50: number;
  /**
   * Relative instruction-following quality, 0..1. Intended to be the composite
   * from `pnpm eval` for this model; seeded until a live evaluation has run.
   */
  qualityScore: number;
  /** USD per session at our median turn count. 0 for on-device. */
  costPerSessionUsd: number;
  /** Runs with no network at all. */
  offlineCapable: boolean;
  /** Set when the backend requires hardware the browser may not have. */
  requiresWebGpu?: boolean;
  /**
   * GPU memory the weights need, in MB, as published by the runtime.
   *
   * The one number in this descriptor that is measured rather than assumed: it
   * comes from WebLLM's own model records. It matters because three models
   * share one tab, so a model that fits alone can still fail next to the
   * recogniser and the voice.
   */
  vramMb?: number;
}

export interface RoutingPolicy {
  /** Hard constraint. When true, only 'device' residency is eligible. */
  requireOnDevice: boolean;
  /** Hard constraint. Empty means no residency restriction. */
  allowedResidencies: Residency[];
  /** Hard constraint on measured first-token latency. */
  maxFirstTokenMs: number;
  /** Tie-break: prefer the better model over the cheaper/faster one. */
  preferQuality: boolean;
  /**
   * GPU memory available to the language model after the other on-device
   * stages have taken theirs, in MB. Undefined means do not filter on memory.
   */
  vramBudgetMb?: number;
}

export interface RuntimeEnvironment {
  hasWebGpu: boolean;
  online: boolean;
}

/**
 * GPU memory the non-LLM on-device stages occupy.
 *
 * Measured from the published weight sizes of the exact artifacts the manifest
 * pins: Whisper encoder 78MB + merged decoder 198MB + Kokoro 310MB = 586MB,
 * rounded up for runtime overhead. Used to turn a device's total budget into
 * what is left for the interviewer model, so the router cannot select something
 * that fits alone but not alongside the rest of the pipeline.
 */
export const NON_LLM_STAGE_VRAM_MB = 650;

export interface RoutingDecision {
  selected?: ModelDescriptor;
  /** Why each candidate was rejected, in evaluation order. Surfaced in the
   *  diagnostics panel — "why am I on the slow model" is the single most common
   *  support question a portable stack generates. */
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * First-token budget for a spoken turn.
 *
 * Derived from the pipeline budget rather than picked: LATENCY_BUDGET allows
 * ~800ms from the learner falling silent to the first audible word, and speech
 * recognition and the first synthesis both have to happen inside it. That
 * leaves roughly this much for the model to produce its first token.
 *
 * Treating it as a hard constraint is the whole design of the realtime path.
 * A bigger model is always available and always better; the reason not to use
 * it is that a reply which arrives late stops being a conversation. So latency
 * filters, and quality decides among whatever is left.
 */
export const REALTIME_FIRST_TOKEN_BUDGET_MS = 400;

export const DEFAULT_POLICY: RoutingPolicy = {
  requireOnDevice: true,
  allowedResidencies: ['device'],
  maxFirstTokenMs: REALTIME_FIRST_TOKEN_BUDGET_MS,
  // Best model that still answers fast enough to feel like a conversation.
  preferQuality: true,
};

/**
 * Pick a model. Pure, so the same decision can be asserted in tests and
 * replayed in the eval harness.
 *
 * Hard constraints filter; the survivors sort by policy preference. Ordering is
 * total (id breaks ties) so the choice never flaps between equal candidates.
 */
export function selectModel(
  candidates: ModelDescriptor[],
  policy: RoutingPolicy,
  env: RuntimeEnvironment,
): RoutingDecision {
  const rejected: RoutingDecision['rejected'] = [];
  const eligible: ModelDescriptor[] = [];

  for (const c of candidates) {
    if (policy.requireOnDevice && c.residency !== 'device') {
      rejected.push({ id: c.id, reason: 'policy requires on-device inference' });
      continue;
    }
    if (policy.allowedResidencies.length > 0 && !policy.allowedResidencies.includes(c.residency)) {
      rejected.push({ id: c.id, reason: `residency ${c.residency} not permitted` });
      continue;
    }
    if (c.requiresWebGpu && !env.hasWebGpu) {
      rejected.push({ id: c.id, reason: 'requires WebGPU, not available on this device' });
      continue;
    }
    if (!c.offlineCapable && !env.online) {
      rejected.push({ id: c.id, reason: 'offline and model requires network' });
      continue;
    }
    if (
      policy.vramBudgetMb !== undefined &&
      c.vramMb !== undefined &&
      c.vramMb > policy.vramBudgetMb
    ) {
      rejected.push({
        id: c.id,
        reason: `needs ${c.vramMb}MB of GPU memory, only ${policy.vramBudgetMb}MB available for the model`,
      });
      continue;
    }
    if (c.firstTokenMsP50 > policy.maxFirstTokenMs) {
      rejected.push({
        id: c.id,
        reason: `first-token ${c.firstTokenMsP50}ms exceeds budget ${policy.maxFirstTokenMs}ms`,
      });
      continue;
    }
    eligible.push(c);
  }

  eligible.sort((a, b) => {
    if (policy.preferQuality && a.qualityScore !== b.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }
    if (a.firstTokenMsP50 !== b.firstTokenMsP50) return a.firstTokenMsP50 - b.firstTokenMsP50;
    if (a.costPerSessionUsd !== b.costPerSessionUsd) return a.costPerSessionUsd - b.costPerSessionUsd;
    return a.id.localeCompare(b.id);
  });

  const selected = eligible[0];
  return selected ? { selected, rejected } : { rejected };
}
