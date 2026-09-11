import type { Phase } from '../state/store.js';

/**
 * The two things this app is for.
 *
 * Previously there was no navigation at all: the phase was a ternary chain in
 * App, and the evaluation harness — half the reason the project exists — was
 * reachable only through a sentence of small print under the start button.
 * A capability nobody can find is a capability nobody has.
 *
 * Two destinations, not four. `live` and `debrief` are states a conversation
 * passes through, not places to go; putting them in a navigation bar would
 * offer people a "Debrief" tab that is empty until they have earned it, which
 * is a worse experience than not offering it. So the bar shows where you can
 * *go*, and the conversation's own progress is the screen's business.
 */
export type Destination = 'talk' | 'evals';

export function destinationFor(phase: Phase): Destination {
  return phase === 'evals' ? 'evals' : 'talk';
}

const TABS: { id: Destination; label: string; hint: string }[] = [
  { id: 'talk', label: 'Talk', hint: 'Hold a live conversation with a model on this device' },
  { id: 'evals', label: 'Evals', hint: 'Score a model against checks and a rubric' },
];

export function Nav({
  phase,
  onNavigate,
}: {
  phase: Phase;
  onNavigate: (to: Destination) => void;
}) {
  const current = destinationFor(phase);
  // A live session owns the microphone and an audio graph. Leaving without
  // ending it would strand both — the mic light stays on, and the model keeps
  // talking to an empty room. The screen's own control ends it properly, so
  // the guard here is to make the tabs unavailable and say why, rather than to
  // silently tear the session down behind someone's back.
  const locked = phase === 'live';

  return (
    <nav className="nav" aria-label="Sections">
      <ul className="nav__list">
        {TABS.map((tab) => {
          const active = tab.id === current;
          return (
            <li key={tab.id}>
              <button
                type="button"
                className={`nav__tab ${active ? 'nav__tab--active' : ''}`}
                aria-current={active ? 'page' : undefined}
                disabled={locked && !active}
                title={locked && !active ? 'End the conversation first' : tab.hint}
                onClick={() => onNavigate(tab.id)}
              >
                {tab.label}
              </button>
            </li>
          );
        })}
      </ul>
      {locked && <p className="nav__lock">End the conversation to move around.</p>}
    </nav>
  );
}
