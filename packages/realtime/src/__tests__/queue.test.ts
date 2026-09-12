import { describe, expect, it } from 'vitest';
import { EventQueue } from '../queue.js';

describe('EventQueue', () => {
  it('delivers values pushed before anyone reads, in order', async () => {
    const q = new EventQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    expect(seen).toEqual([1, 2]);
  });

  it('wakes a waiting consumer', async () => {
    const q = new EventQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    const next = iterator.next();
    q.push('late');
    expect(await next).toEqual({ value: 'late', done: false });
  });

  it('drains what is queued before reporting done', async () => {
    // Closing must not discard events already received; the last thing a
    // stream says is often the most important.
    const q = new EventQueue<number>();
    q.push(1);
    q.close();

    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    expect(seen).toEqual([1]);
  });

  it('ends a consumer that was already waiting when it closes', async () => {
    const q = new EventQueue<number>();
    const iterator = q[Symbol.asyncIterator]();
    const next = iterator.next();
    q.close();
    expect(await next).toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after close', async () => {
    const q = new EventQueue<number>();
    q.close();
    q.push(99);
    expect(q.pending).toBe(0);
  });
});
