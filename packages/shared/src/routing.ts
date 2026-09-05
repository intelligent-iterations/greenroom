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
}

export interface RuntimeEnvironment {
  hasWebGpu: boolean;
  online: boolean;
}

export interface RoutingDecision {
  selected?: ModelDescriptor;
  /** Why each candidate was rejected, in evaluation order. Surfaced in the
   *  diagnostics panel — "why am I on the slow model" is the single most common
   *  support question a portable stack generates. */
  rejected: Array<{ id: string; reason: string }>;
}

export const DEFAULT_POLICY: RoutingPolicy = {
  requireOnDevice: true,
  allowedResidencies: ['device'],
  maxFirstTokenMs: 2000,
  preferQuality: false,
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
