import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import { describe, expect, it } from 'vitest';
import { MODEL_CATALOGUE } from '../models.js';

/**
 * Guards the one class of bug that is invisible until a learner hits it: a
 * catalogue entry naming a model WebLLM cannot load. The failure would surface
 * as a download error seconds into a session, on someone else's machine.
 */
describe('on-device catalogue', () => {
  const onDevice = MODEL_CATALOGUE.filter((m) => m.vendor === 'on-device');
  const prebuilt = new Map(
    prebuiltAppConfig.model_list.map((m) => [m.model_id, m.vram_required_MB]),
  );

  it('has at least one on-device model', () => {
    expect(onDevice.length).toBeGreaterThan(0);
  });

  it.each(onDevice.map((m) => [m.id, m] as const))(
    '%s exists in WebLLM prebuiltAppConfig',
    (_id, model) => {
      expect(prebuilt.has(model.id)).toBe(true);
    },
  );

  it.each(onDevice.map((m) => [m.id, m] as const))(
    '%s declares VRAM matching the runtime record',
    (_id, model) => {
      const actual = prebuilt.get(model.id);
      expect(actual).toBeDefined();
      // Rounded in the catalogue for readability; must not drift from reality.
      expect(Math.abs((model.vramMb ?? 0) - (actual ?? 0))).toBeLessThan(1);
    },
  );

  it('orders seed quality by model size within the Qwen3.5 family', () => {
    const q = (id: string) => MODEL_CATALOGUE.find((m) => m.id === id)!.qualityScore;
    expect(q('Qwen3.5-0.8B-q4f16_1-MLC')).toBeLessThan(q('Qwen3.5-2B-q4f16_1-MLC'));
    expect(q('Qwen3.5-2B-q4f16_1-MLC')).toBeLessThan(q('Qwen3.5-4B-q4f16_1-MLC'));
  });

  it('marks every on-device model as offline-capable and WebGPU-only', () => {
    for (const m of onDevice) {
      expect(m.offlineCapable).toBe(true);
      expect(m.requiresWebGpu).toBe(true);
      expect(m.costPerSessionUsd).toBe(0);
    }
  });
});
