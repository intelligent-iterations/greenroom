import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, selectModel, type ModelDescriptor, type RoutingPolicy } from '../routing.js';

const onDevice: ModelDescriptor = {
  id: 'qwen3-1.7b-webgpu',
  vendor: 'on-device',
  label: 'On-device',
  residency: 'device',
  firstTokenMsP50: 420,
  qualityScore: 0.62,
  costPerSessionUsd: 0,
  offlineCapable: true,
  requiresWebGpu: true,
};

const azure: ModelDescriptor = {
  id: 'azure-gpt-4o-mini',
  vendor: 'azure-openai',
  label: 'Azure',
  residency: 'ca-region',
  firstTokenMsP50: 610,
  qualityScore: 0.86,
  costPerSessionUsd: 0.014,
  offlineCapable: false,
};

const gemini: ModelDescriptor = {
  id: 'gemini-3-flash',
  vendor: 'google-gemini',
  label: 'Gemini',
  residency: 'us-region',
  firstTokenMsP50: 380,
  qualityScore: 0.88,
  costPerSessionUsd: 0.009,
  offlineCapable: false,
};

const all = [onDevice, azure, gemini];
const env = { hasWebGpu: true, online: true };

describe('selectModel', () => {
  it('keeps everything on-device under the default policy', () => {
    const d = selectModel(all, DEFAULT_POLICY, env);
    expect(d.selected?.id).toBe('qwen3-1.7b-webgpu');
    expect(d.rejected.map((r) => r.id)).toEqual(['azure-gpt-4o-mini', 'gemini-3-flash']);
  });

  it('falls back off-device when WebGPU is missing', () => {
    const policy: RoutingPolicy = { ...DEFAULT_POLICY, requireOnDevice: false, allowedResidencies: [] };
    const d = selectModel(all, policy, { hasWebGpu: false, online: true });
    expect(d.selected?.id).toBe('gemini-3-flash');
    expect(d.rejected[0]?.reason).toMatch(/WebGPU/);
  });

  it('excludes non-Canadian residency when the policy demands it', () => {
    const policy: RoutingPolicy = {
      ...DEFAULT_POLICY,
      requireOnDevice: false,
      allowedResidencies: ['device', 'ca-region'],
    };
    const d = selectModel(all, policy, { hasWebGpu: false, online: true });
    expect(d.selected?.id).toBe('azure-gpt-4o-mini');
    expect(d.rejected.some((r) => r.id === 'gemini-3-flash' && /residency/.test(r.reason))).toBe(true);
  });

  it('prefers quality when asked and latency otherwise', () => {
    // Deliberately opposed: `slowSmart` wins on quality, `gemini` on latency.
    const slowSmart: ModelDescriptor = {
      ...azure,
      id: 'azure-gpt-4o',
      qualityScore: 0.94,
      firstTokenMsP50: 900,
    };
    const base: RoutingPolicy = { ...DEFAULT_POLICY, requireOnDevice: false, allowedResidencies: [] };
    expect(selectModel([slowSmart, gemini], base, env).selected?.id).toBe('gemini-3-flash');
    expect(selectModel([slowSmart, gemini], { ...base, preferQuality: true }, env).selected?.id).toBe(
      'azure-gpt-4o',
    );
  });

  it('returns no selection rather than violating a hard constraint', () => {
    const d = selectModel([azure, gemini], DEFAULT_POLICY, env);
    expect(d.selected).toBeUndefined();
    expect(d.rejected).toHaveLength(2);
  });

  it('enforces the latency budget', () => {
    const policy: RoutingPolicy = {
      ...DEFAULT_POLICY,
      requireOnDevice: false,
      allowedResidencies: [],
      maxFirstTokenMs: 400,
    };
    const d = selectModel(all, policy, env);
    expect(d.selected?.id).toBe('gemini-3-flash');
    expect(d.rejected.some((r) => /exceeds budget/.test(r.reason))).toBe(true);
  });
});
