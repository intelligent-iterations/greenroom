import type { DuplexCapabilities, InterviewScenario, LearnerState } from '@greenroom/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSession } from '../realtime-session.js';
import { BARGE_IN_GUARD_MS } from '../session.js';
import { ScriptedDuplexTransport } from './duplex-fakes.js';
import { FakeVad, flush } from './fakes.js';

const scenario: InterviewScenario = {
  id: 's1',
  title: 'Backend engineer',
  interviewerPersona: 'a staff engineer',
  company: 'Northwind',
  role: 'Backend Engineer',
  seniority: 'mid',
  language: 'en',
  targetCompetencies: ['quantified_impact'],
  requiredQuestions: ['Walk me through a system you owned.'],
  contextNotes: [],
  maxTurns: 3,
};

const learner: LearnerState = {
  userId: 'u1',
  cefr: 'B2',
  seniority: 'mid',
  language: 'en',
  targetRole: 'Backend Engineer',
  mastery: [],
  recentErrors: [],
  sessionsCompleted: 0,
  updatedAt: 0,
  documents: [],
};

let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random()}` });
});
afterEach(() => vi.restoreAllMocks());

function build(caps: Partial<DuplexCapabilities> = {}) {
  const stage = new ScriptedDuplexTransport(caps);
  const vad = new FakeVad();
  const session = new RealtimeSession({
    scenario,
    learner,
    stage,
    vad,
    systemPrompt: 'SYSTEM_MARKER',
  });
  const timings: unknown[] = [];
  session.on('timings', (t) => timings.push(t));
  return { session, stage, vad, timings };
}

/** One complete exchange: the learner speaks, the interviewer answers. */
async function exchange(stage: ScriptedDuplexTransport) {
  stage.emit({ type: 'user_speech_started', at: 0 });
  stage.emit({ type: 'user_transcript', text: 'I owned the billing service.', final: true, at: 90 });
  stage.emit({ type: 'user_speech_stopped', at: 100 });
  await flush();
  stage.emit({ type: 'assistant_transcript', text: 'What did it cost you?', final: true, at: 400 });
  stage.emit({ type: 'assistant_audio', chunk: { samples: new Float32Array(4), sampleRate: 24000 }, at: 500 });
  stage.emit({ type: 'assistant_turn_complete', at: 900 });
  await flush();
}

describe('RealtimeSession transcript', () => {
  it('records the learner and the interviewer in conversational order', async () => {
    const { session, stage } = build();
    await session.start();
    await exchange(stage);

    expect(session.turns.map((t) => t.role)).toEqual(['learner', 'interviewer']);
    expect(session.turns[1]?.text).toBe('What did it cost you?');
  });

  it('passes the compiled prompt to the vendor once, at open', async () => {
    const { session, stage } = build();
    await session.start();
    expect(stage.openedWith?.systemPrompt).toBe('SYSTEM_MARKER');
  });

  // Same rule as the cascade: the next turn must follow what the learner
  // actually heard, not what the model happened to generate.
  it('records what was heard when the vendor reports an interruption', async () => {
    const { session, stage } = build();
    await session.start();
    stage.emit({ type: 'user_speech_stopped', at: 100 });
    await flush();
    stage.emit({ type: 'assistant_transcript', text: 'What did it cost you, and who else was involved?', final: false, at: 300 });
    stage.emit({ type: 'assistant_audio', chunk: { samples: new Float32Array(2), sampleRate: 24000 }, at: 350 });
    stage.emit({ type: 'assistant_interrupted', spokenText: 'What did it cost you,', at: 500 });
    await flush();

    expect(session.turns.at(-1)?.text).toBe('What did it cost you,');
    expect(session.turns.at(-1)?.bargedIn).toBe(true);
  });

  it('falls back to the accumulated text when the vendor does not say what was spoken', async () => {
    const { session, stage } = build();
    await session.start();
    stage.emit({ type: 'user_speech_stopped', at: 100 });
    await flush();
    stage.emit({ type: 'assistant_transcript', text: 'What did it cost', final: false, at: 300 });
    stage.emit({ type: 'assistant_interrupted', at: 500 });
    await flush();

    expect(session.turns.at(-1)?.text).toBe('What did it cost');
  });
});

describe('RealtimeSession timings', () => {
  it('anchors everything to the moment the learner stopped speaking', async () => {
    const { session, stage, timings } = build();
    await session.start();
    await exchange(stage);

    expect(timings[0]).toMatchObject({
      speechEndedAt: 100,
      firstTokenMs: 300,
      firstAudioMs: 400,
      turnaroundMs: 800,
    });
  });

  // A duplex stream has no recognition boundary. ADR 0002's "a duplex stream
  // says the turn was slow" has to show up as a blank, never a zero.
  it('never invents an sttMs', async () => {
    const { session, stage, timings } = build();
    await session.start();
    await exchange(stage);

    expect((timings[0] as { sttMs?: number }).sttMs).toBeUndefined();
  });

  it('leaves firstTokenMs unset when the vendor text does not lead its audio', async () => {
    const { session, stage, timings } = build({ transcriptsLeadAudio: false });
    await session.start();
    await exchange(stage);

    const t = timings[0] as { firstTokenMs?: number; firstAudioMs?: number };
    expect(t.firstTokenMs).toBeUndefined();
    expect(t.firstAudioMs).toBe(400);
  });
});

describe('RealtimeSession barge-in ownership', () => {
  it('never starts a VAD when the vendor handles interruption itself', async () => {
    const { session, vad } = build({ nativeBargeIn: true });
    await session.start();
    expect(vad.running).toBe(false);
  });

  it('interrupts the vendor when the local VAD hears speech during playback', async () => {
    const { session, stage, vad } = build({ nativeBargeIn: false });
    await session.start();
    stage.emit({ type: 'user_speech_stopped', at: 0 });
    await flush();
    stage.emit({ type: 'assistant_audio', chunk: { samples: new Float32Array(2), sampleRate: 24000 }, at: 0 });
    await flush();

    clock = BARGE_IN_GUARD_MS + 50;
    vad.handlers?.onSpeechStart();
    expect(stage.interruptCalls).toBe(1);
  });

  // The same guard window as the cascade, imported rather than copied: the
  // vendor's own first syllable leaks into an open mic before echo
  // cancellation converges.
  it('ignores speech inside the guard window', async () => {
    const { session, stage, vad } = build({ nativeBargeIn: false });
    await session.start();
    stage.emit({ type: 'user_speech_stopped', at: 0 });
    await flush();
    stage.emit({ type: 'assistant_audio', chunk: { samples: new Float32Array(2), sampleRate: 24000 }, at: 0 });
    await flush();

    clock = BARGE_IN_GUARD_MS - 50;
    vad.handlers?.onSpeechStart();
    expect(stage.interruptCalls).toBe(0);
  });
});

describe('RealtimeSession refuses what it cannot deliver', () => {
  // A transcript is a product requirement, not a feature: the debrief quotes it
  // and the mastery scorer reads it as evidence.
  it('will not start against a vendor that emits no assistant transcript', async () => {
    const { session } = build({ assistantTranscripts: false });
    await expect(session.start()).rejects.toThrow(/debrief or a score/);
    expect(session.state).toBe('error');
  });

  it('surfaces a stream error and stops the microphone', async () => {
    const { session, stage, vad } = build();
    await session.start();
    stage.emit({ type: 'error', error: new Error('socket closed'), at: 10 });
    await flush();

    expect(session.state).toBe('error');
    expect(vad.destroyed).toBe(true);
  });
});

describe('RealtimeSession microphone', () => {
  it('streams captured audio upstream', async () => {
    const { session, stage } = build();
    await session.start();
    session.send({ samples: new Float32Array(160), sampleRate: 16000 });
    expect(stage.sent).toHaveLength(1);
  });
});
