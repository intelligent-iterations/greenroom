/**
 * Ring-buffered diagnostics for the voice loop.
 *
 * A live microphone session cannot be stepped through in a debugger — the bug
 * is usually "it did not interrupt when I talked over it", which is a question
 * about the ordering and timing of events that already happened. So the loop
 * records what it did, and the record is read afterwards.
 *
 * Bounded on purpose. An earlier version of the benchmark logged a DOM node per
 * progress callback, reached 42,000 nodes, and the layout work competed with
 * the inference it was measuring. Instrumentation that perturbs the thing being
 * measured is worse than none, so this is a fixed-size array with no DOM work
 * and no per-event rendering.
 */
export interface DiagnosticEvent {
  /** ms since the log was created, so events can be read as a timeline. */
  t: number;
  event: string;
  data?: Record<string, unknown>;
}

const CAPACITY = 500;
const started = performance.now();
const buffer: DiagnosticEvent[] = [];

/** Set true to mirror events to the console; off by default to keep it quiet. */
let echo = false;

const STORAGE_KEY = 'greenroom.diagnostics.last';

/**
 * Mirrors the buffer to localStorage, throttled.
 *
 * A live session's log is evidence about something that already happened, and
 * reloading the page previously destroyed it — which cost us the record of a
 * real failure a tester had just reproduced. Throttled because writing on every
 * event would put JSON serialisation on the path of the loop it observes.
 */
let lastPersist = 0;
const PERSIST_INTERVAL_MS = 2000;

function persist(): void {
  const now = performance.now();
  if (now - lastPersist < PERSIST_INTERVAL_MS) return;
  lastPersist = now;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
  } catch {
    // Private browsing or quota. In-memory buffer still works.
  }
}

/** The log from the previous page load, if there was one. */
export function previousEvents(): DiagnosticEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DiagnosticEvent[]) : [];
  } catch {
    return [];
  }
}

export function logEvent(event: string, data?: Record<string, unknown>): void {
  const entry: DiagnosticEvent = {
    t: Math.round(performance.now() - started),
    event,
    ...(data ? { data } : {}),
  };
  buffer.push(entry);
  if (buffer.length > CAPACITY) buffer.shift();
  if (echo) console.log(`[greenroom +${entry.t}ms] ${event}`, data ?? '');
  persist();
}

export function getEvents(): DiagnosticEvent[] {
  return [...buffer];
}

export function setEcho(on: boolean): void {
  echo = on;
}

/** Human-readable timeline, for pasting into a bug report. */
export function formatEvents(): string {
  return buffer
    .map((e) => `+${String(e.t).padStart(6)}ms  ${e.event}${e.data ? '  ' + JSON.stringify(e.data) : ''}`)
    .join('\n');
}

// Exposed so a session can be inspected from the console or by an automation
// driver after the fact, without wiring a UI for it.
declare global {
  interface Window {
    __GREENROOM__?: {
      events: () => DiagnosticEvent[];
      text: () => string;
      echo: (on: boolean) => void;
      /** The log from the previous page load, which a reload used to destroy. */
      previous: () => DiagnosticEvent[];
    };
  }
}

if (typeof window !== 'undefined') {
  window.__GREENROOM__ = {
    events: getEvents,
    text: formatEvents,
    echo: setEcho,
    previous: previousEvents,
  };
}
