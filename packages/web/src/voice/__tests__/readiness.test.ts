import { describe, expect, it } from 'vitest';
import { assessReadiness } from '../readiness.js';
import type { DeviceCapabilities } from '../capabilities.js';

const base: DeviceCapabilities = {
  hasWebGpu: true,
  hasSharedArrayBuffer: true,
  hasWebSpeechSynthesis: true,
  threads: 8,
};

describe('assessReadiness', () => {
  it('clears a machine with WebGPU and room to spare', () => {
    const v = assessReadiness({ ...base, maxBufferMb: 4096, gpuDescription: 'apple m-series' });
    expect(v.level).toBe('full');
    expect(v.detail).toContain('apple m-series');
  });

  // maxBufferSize is a real constraint, not a proxy for taste: weights are
  // allocated as buffers, so a model above the limit cannot load at all.
  it('blocks a GPU whose buffer limit is below the smallest bundled model', () => {
    const v = assessReadiness({ ...base, maxBufferMb: 128 });
    expect(v.level).toBe('blocked');
    expect(v.detail).toMatch(/128 MB/);
    if (v.level === 'blocked') expect(v.remedies.join(' ')).toMatch(/smaller model|folder/);
  });

  it('treats an unknown buffer limit as workable rather than guessing', () => {
    expect(assessReadiness({ ...base, maxBufferMb: undefined }).level).toBe('full');
  });

  it('degrades to threaded WASM when there is no GPU but isolation holds', () => {
    const v = assessReadiness({ ...base, hasWebGpu: false, threads: 12 });
    expect(v.level).toBe('degraded');
    expect(v.detail).toContain('12 threads');
  });

  // The repo's rule: an unmeasured number is labelled as one.
  it('says plainly that the CPU estimate is unmeasured', () => {
    const v = assessReadiness({ ...base, hasWebGpu: false });
    if (v.level === 'degraded') expect(v.expect).toMatch(/estimate, not a measurement/);
  });

  it('blocks when neither engine is available, and says what to do', () => {
    const v = assessReadiness({ ...base, hasWebGpu: false, hasSharedArrayBuffer: false });
    expect(v.level).toBe('blocked');
    if (v.level === 'blocked') {
      expect(v.remedies.length).toBeGreaterThan(1);
      expect(v.remedies.join(' ')).toMatch(/Chrome|Safari/);
    }
  });

  it('never returns a blocked verdict without a remedy', () => {
    const cases: DeviceCapabilities[] = [
      { ...base, hasWebGpu: false, hasSharedArrayBuffer: false },
      { ...base, maxBufferMb: 1 },
    ];
    for (const caps of cases) {
      const v = assessReadiness(caps);
      if (v.level === 'blocked') expect(v.remedies.length).toBeGreaterThan(0);
    }
  });
});
