/** Minimal typed event emitter. A dependency for this would be silly. */
export class Emitter<Events extends Record<string, (...args: never[]) => void>> {
  #listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      // A throwing UI listener must not abort the voice loop mid-turn.
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`listener for "${String(event)}" threw`, err);
      }
    }
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }
}
