/**
 * A single-consumer async queue.
 *
 * The adapter receives events from a socket callback and publishes them through
 * an `AsyncIterable`. Those are different worlds: the socket does not wait, and
 * the consumer might be. Events that arrive while nobody is reading must be
 * kept in order, and a consumer that is ahead must park rather than spin.
 *
 * Small enough to own rather than take a dependency for, and the ordering it
 * guarantees is worth testing directly.
 */
export class EventQueue<T> {
  #buffer: T[] = [];
  #waiting?: (value: IteratorResult<T>) => void;
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting({ value, done: false });
      return;
    }
    this.#buffer.push(value);
  }

  /** Ends the stream once everything already queued has been read. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  get pending(): number {
    return this.#buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this.#buffer.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
