import { describe, expect, it } from 'vitest';
import { findStage } from '../model-manifest.js';
import { MODEL_CATALOGUE } from '../models.js';

/**
 * Guards the bug class that cost us a rewrite: a catalogue entry naming a model
 * the runtime cannot actually fetch. The offline half is here; `pnpm preflight`
 * does the network half.
 */
describe('on-device catalogue', () => {
  const onDevice = MODEL_CATALOGUE.filter((m) => m.vendor === 'on-device');

  it('has at least one on-device model', () => {
    expect(onDevice.length).toBeGreaterThan(0);
  });

  it('names the same repository the manifest will fetch from', () => {
    // If these drift, preflight verifies one model and the app loads another.
    expect(onDevice.map((m) => m.id)).toContain(findStage('llm').repo);
  });

  it('marks every on-device model offline-capable, WebGPU-only and free', () => {
    for (const m of onDevice) {
      expect(m.offlineCapable).toBe(true);
      expect(m.requiresWebGpu).toBe(true);
      expect(m.costPerSessionUsd).toBe(0);
    }
  });

  it('declares a weight size for every on-device model', () => {
    // Required for memory-aware routing; without it the model is unfiltered.
    for (const m of onDevice) expect(m.vramMb).toBeGreaterThan(0);
  });

  it('gives cloud models a residency that is not "device"', () => {
    for (const m of MODEL_CATALOGUE.filter((x) => x.vendor !== 'on-device')) {
      expect(m.residency).not.toBe('device');
    }
  });
});
