import { describe, expect, it } from 'vitest';
import { destinationFor } from '../Nav.js';

/**
 * The mapping from session phase to navigation destination.
 *
 * Pure, and worth pinning: the failure it prevents is a `debrief` or `live`
 * phase matching no tab, which renders a navigation bar with nothing marked
 * current — the state where a person cannot tell where they are.
 */
describe('destinationFor', () => {
  it('treats setup as the talk destination', () => {
    expect(destinationFor('setup')).toBe('talk');
  });

  it('keeps a live conversation under talk', () => {
    expect(destinationFor('live')).toBe('talk');
  });

  it('keeps the debrief under talk', () => {
    // A debrief is the tail of a conversation, not a third place to go.
    expect(destinationFor('debrief')).toBe('talk');
  });

  it('maps evals to its own destination', () => {
    expect(destinationFor('evals')).toBe('evals');
  });

  it('maps the end-to-end model to its own destination', () => {
    expect(destinationFor('realtime')).toBe('realtime');
  });

  it('leaves no phase without a tab', () => {
    const phases = ['setup', 'live', 'debrief', 'evals', 'realtime'] as const;
    for (const phase of phases) {
      expect(['talk', 'realtime', 'evals']).toContain(destinationFor(phase));
    }
  });
});
