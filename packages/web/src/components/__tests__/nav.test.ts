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

  it('leaves no phase without a tab', () => {
    const phases = ['setup', 'live', 'debrief', 'evals'] as const;
    for (const phase of phases) {
      expect(['talk', 'evals']).toContain(destinationFor(phase));
    }
  });
});
