import { describe, expect, it, vi } from 'vitest';
import { SpeculativeTranscriber, toleranceFor, type Transcriber } from '../speculative-stt.js';

const SAMPLE_RATE = 16_000;

/** `seconds` of audio. Contents are irrelevant; only lengths are compared. */
const audio = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE));

/** A transcriber whose completion the test controls. */
function controllable() {
  const calls: Float32Array[] = [];
  let release!: (text: string) => void;
  const transcriber: Transcriber = {
    transcribe: (a) => {
      calls.push(a);
      return new Promise((resolve) => {
        release = (text) => resolve({ text });
      });
    },
  };
  return { transcriber, calls, release: (t: string) => release(t) };
}

/** A transcriber that answers immediately with the audio's duration. */
const instant = (text = 'hello there'): Transcriber => ({
  transcribe: async () => ({ text }),
});

describe('SpeculativeTranscriber', () => {
  it('transcribes normally when nothing was speculated', async () => {
    const t = new SpeculativeTranscriber(instant());
    const result = await t.claim(audio(3));
    expect(result.source).toBe('full');
    expect(result.text).toBe('hello there');
  });

  it('uses a finished speculation and does not transcribe again', async () => {
    const transcribe = vi.fn(async () => ({ text: 'spoken words' }));
    const t = new SpeculativeTranscriber({ transcribe });

    t.speculate(audio(3));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));

    // The VAD appends the 800ms it spent measuring silence.
    const result = await t.claim(audio(3.8));

    expect(result.source).toBe('speculative');
    expect(result.text).toBe('spoken words');
    // The whole point: one pass, not two.
    expect(transcribe).toHaveBeenCalledTimes(1);
    // And the learner waited on essentially nothing at the endpoint.
    expect(result.waitedMs).toBeLessThan(50);
  });

  it('awaits an unfinished speculation rather than starting a second pass', async () => {
    const { transcriber, calls, release } = controllable();
    const t = new SpeculativeTranscriber(transcriber);

    t.speculate(audio(3));
    const claimed = t.claim(audio(3.5));
    release('still going');

    const result = await claimed;
    expect(result.source).toBe('speculative');
    expect(result.text).toBe('still going');
    // Awaited, not restarted: one pass total.
    expect(calls).toHaveLength(1);
  });

  it('discards the speculation when the learner kept talking', async () => {
    const transcribe = vi.fn(async (a: Float32Array) => ({
      text: a.length > 4 * SAMPLE_RATE ? 'the whole answer' : 'half an answer',
    }));
    const t = new SpeculativeTranscriber({ transcribe });

    t.speculate(audio(3));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));

    // Three more seconds of speech after the pause — a mid-sentence breath.
    const result = await t.claim(audio(6));

    // This is the failure that would put words in a learner's mouth.
    expect(result.source).toBe('full');
    expect(result.text).toBe('the whole answer');
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1]?.[0]).toHaveLength(6 * SAMPLE_RATE);
  });

  it('discards a speculation longer than the final audio', async () => {
    // Should be impossible, and would silently transcribe a different
    // utterance if it ever happened.
    const transcribe = vi.fn(async () => ({ text: 'x' }));
    const t = new SpeculativeTranscriber({ transcribe });

    t.speculate(audio(5));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));

    const result = await t.claim(audio(2));
    expect(result.source).toBe('full');
  });

  it('accepts appended audio right at the tolerance and rejects past it', async () => {
    const within = new SpeculativeTranscriber(instant());
    within.speculate(audio(3));
    expect((await within.claim(audio(3 + 1.2))).source).toBe('speculative');

    const beyond = new SpeculativeTranscriber(instant());
    beyond.speculate(audio(3));
    expect((await beyond.claim(audio(3 + 1.3))).source).toBe('full');
  });

  it('derives the tolerance from the endpoint window', () => {
    // Raising redemptionMs must widen the window, or every speculation on a
    // patient VAD would be discarded as if the learner had kept talking.
    expect(toleranceFor(800)).toBe(1200);
    expect(toleranceFor(1500)).toBe(1900);
    expect(toleranceFor(1500)).toBeGreaterThan(toleranceFor(800));
  });

  it('honours a caller-supplied tolerance', async () => {
    const t = new SpeculativeTranscriber(instant(), toleranceFor(1500));
    t.speculate(audio(3));
    // 1.4s appended would be rejected at the default and is fine at this one.
    expect((await t.claim(audio(4.4))).source).toBe('speculative');
  });

  it('forgets an abandoned speculation', async () => {
    const transcribe = vi.fn(async () => ({ text: 'stale' }));
    const t = new SpeculativeTranscriber({ transcribe });

    t.speculate(audio(3));
    t.abandon('speech resumed');
    expect(t.speculating).toBe(false);

    const result = await t.claim(audio(3.2));
    // Must not resurrect the abandoned pass, even though the lengths match.
    expect(result.source).toBe('full');
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('keeps the earlier speculation when asked twice', async () => {
    const transcribe = vi.fn(async (_audio: Float32Array) => ({ text: 'first' }));
    const t = new SpeculativeTranscriber({ transcribe });

    t.speculate(audio(3));
    t.speculate(audio(3.1));

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]?.[0]).toHaveLength(3 * SAMPLE_RATE);
  });

  it('ignores a speculation on empty audio', () => {
    const transcribe = vi.fn(async () => ({ text: '' }));
    const t = new SpeculativeTranscriber({ transcribe });
    t.speculate(new Float32Array(0));
    expect(t.speculating).toBe(false);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('falls back to a full pass when the speculation throws', async () => {
    let call = 0;
    const transcribe = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('worker died');
      return { text: 'recovered' };
    });
    const t = new SpeculativeTranscriber({ transcribe });

    t.speculate(audio(3));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));

    // A failed speculation resolves to empty text rather than rejecting, so the
    // turn continues; the learner never sees a crashed session.
    const result = await t.claim(audio(3.5));
    expect(result.text).toBe('');
    expect(() => result).not.toThrow();
  });

  it('does not leave an unhandled rejection when a failed speculation is abandoned', async () => {
    const t = new SpeculativeTranscriber({
      transcribe: async () => {
        throw new Error('worker died');
      },
    });
    t.speculate(audio(3));
    t.abandon('speech resumed');
    // The rejection is caught inside the class; nothing observes it here.
    await new Promise((r) => setTimeout(r, 0));
    expect(t.speculating).toBe(false);
  });

  it('reports speculating only while one is outstanding', async () => {
    const { transcriber, release } = controllable();
    const t = new SpeculativeTranscriber(transcriber);

    expect(t.speculating).toBe(false);
    t.speculate(audio(3));
    expect(t.speculating).toBe(true);

    const claimed = t.claim(audio(3.4));
    expect(t.speculating).toBe(false);
    release('done');
    await claimed;
  });
});
