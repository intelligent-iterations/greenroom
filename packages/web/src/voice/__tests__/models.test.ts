import { describe, expect, it } from 'vitest';
import { findStage } from '../model-manifest.js';
import { MODEL_CATALOGUE, affordableModels } from '../models.js';

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

describe('model tiers', () => {
  const onDevice = MODEL_CATALOGUE.filter((m) => m.vendor === 'on-device');

  it('offers a range of sizes so the choice can follow the hardware', () => {
    const sizes = onDevice.map((m) => m.downloadMb ?? 0).sort((a, b) => a - b);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    // A meaningful spread, not three variants of the same size.
    expect(sizes[sizes.length - 1]! / sizes[0]!).toBeGreaterThan(4);
  });

  it('declares a download size and a note for every selectable model', () => {
    for (const m of onDevice) {
      expect(m.downloadMb).toBeGreaterThan(0);
      expect(m.suitedTo).toBeTruthy();
    }
  });

  it('ranks quality with size, so "bigger" is never also "worse"', () => {
    const bySize = [...onDevice].sort((a, b) => (a.vramMb ?? 0) - (b.vramMb ?? 0));
    const quality = bySize.map((m) => m.qualityScore);
    expect(quality).toEqual([...quality].sort((a, b) => a - b));
  });

  it('only offers models that fit the memory budget', () => {
    // 1500MB leaves room for the small models and not the large ones.
    const fits = affordableModels(1500);
    expect(fits.every((m) => (m.vramMb ?? 0) <= 1500)).toBe(true);
    expect(fits.length).toBeGreaterThan(0);
    expect(fits.length).toBeLessThan(onDevice.length);
  });

  it('offers everything when the device reports no budget', () => {
    expect(affordableModels(undefined)).toHaveLength(onDevice.length);
  });
});
