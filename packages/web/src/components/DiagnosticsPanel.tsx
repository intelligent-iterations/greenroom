import { useEffect, useState } from 'react';
import { getEvents, type DiagnosticEvent } from '../voice/diagnostics.js';

/**
 * Live view of the voice loop's event timeline.
 *
 * Present during a session because the interesting failures are all about
 * ordering and timing — "it did not stop when I talked over it" is a question
 * about whether a speech event arrived and what the loop was doing when it did.
 * Polled rather than pushed so rendering can never sit on the path of the loop
 * it is reporting on.
 */
const POLL_MS = 400;

const INTERESTING = /^(bargeIn|vad\.|stt\.|llm\.firstToken|tts\.firstAudio|turn\.complete|error|worker\.error|audio\.|mic\.)/;

export function DiagnosticsPanel() {
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setEvents(getEvents().filter((e) => INTERESTING.test(e.event))), POLL_MS);
    return () => clearInterval(id);
  }, [open]);

  const recent = events.slice(-40).reverse();

  return (
    <details className="diagnostics" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>What the microphone is doing</summary>
      {recent.length === 0 ? (
        <p className="muted small">No events yet.</p>
      ) : (
        <ul className="events">
          {recent.map((e, i) => (
            <li key={`${e.t}-${i}`}>
              <code>{`+${(e.t / 1000).toFixed(1)}s`}</code> <strong>{e.event}</strong>{' '}
              {e.data && <span className="muted">{JSON.stringify(e.data)}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Paste the full timeline with <code>copy(__GREENROOM__.text())</code> in the browser console.
      </p>
    </details>
  );
}
