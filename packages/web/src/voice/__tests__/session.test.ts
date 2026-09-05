import type { InterviewScenario, LearnerState } from '@greenroom/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterviewSession, type SessionState } from '../session.js';
import { FakeRecognizer, FakeSynthesizer, FakeVad, ScriptedModel, flush } from './fakes.js';

const scenario: InterviewScenario = {
  id: 's1',
  title: 'Backend engineer',
  interviewerPersona: 'a staff engineer',
  company: 'Northwind',
  role: 'Backend Engineer',
  seniority: 'mid',
  language: 'en',
  targetCompetencies: ['quantified_impact', 'concision'],
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
};

/** A controllable clock, because barge-in is guarded on elapsed playback time. */
let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random()}` });
});
afterEach(() => vi.restoreAllMocks());

function build(overrides: { synth?: FakeSynthesizer; transcripts?: string[] } = {}) {
  const vad = new FakeVad();
  const model = new ScriptedModel();
  const recognizer = new FakeRecognizer(overrides.transcripts ?? []);
  const synthesizer = overrides.synth ?? new FakeSynthesizer();
  const states: SessionState[] = [];

  const session = new InterviewSession({
    scenario,
    learner,
    vad,
    stages: { recognizer, model, synthesizer },
  });
  session.on('state', (s) => states.push(s));
  return { session, vad, model, recognizer, synthesizer, states };
}

describe('InterviewSession opening turn', () => {
  it('generates, speaks and records the opening question', async () => {
    const { session, model, synthesizer, states } = build();
    const started = session.start();
    await flush();

    model.script('Walk me through a system you owned end to end.');
    await started;

    expect(synthesizer.spoken).toEqual(['Walk me through a system you owned end to end.']);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.role).toBe('interviewer');
    expect(states).toEqual(['loading', 'thinking', 'speaking', 'listening']);
  });

  it('sends the compiled system prompt as the first message', async () => {
    const { session, model } = build();
    const started = session.start();
    await flush();
    model.script('Hello there, tell me about your work.');
    await started;

    const messages = model.receivedMessages[0]!;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Northwind');
  });

  it('seeds a user turn on the opening so small models have something to answer', () => {
    // Measured: given only a system prompt, a 1.7B model replies with a single
    // word. Given one user message it asks a real question.
    const { session, model } = build();
    void session.start();
    return flush().then(() => {
      model.script('Walk me through a system you owned.');
      const messages = model.receivedMessages[0]!;
      expect(messages).toHaveLength(2);
      expect(messages[1]?.role).toBe('user');
    });
  });

  it('does not show the seeded opening turn to the learner', async () => {
    const { session, model } = build();
    const started = session.start();
    await flush();
    model.script('Walk me through a system you owned.');
    await started;
    // The seed is a prompt-layer device, not something the learner said.
    expect(session.turns.filter((t) => t.role === 'learner')).toHaveLength(0);
  });
});

describe('InterviewSession streaming', () => {
  it('speaks each sentence as it completes rather than waiting for the full turn', async () => {
    const { session, model, synthesizer } = build();
    const started = session.start();
    await flush();

    model.push('That is a good start. ');
    await flush();
    // Audio has begun while the model is still generating — the whole point.
    expect(synthesizer.spoken).toEqual(['That is a good start.']);

    model.push('What did you measure afterwards? ');
    await flush();
    expect(synthesizer.spoken).toHaveLength(2);

    model.finish();
    await started;
  });

  it('speaks a trailing fragment that never terminated', async () => {
    const { session, model, synthesizer } = build();
    const started = session.start();
    await flush();
    model.push('So tell me what happened next');
    model.finish();
    await started;

    expect(synthesizer.spoken).toEqual(['So tell me what happened next']);
  });
});

describe('InterviewSession barge-in', () => {
  it('aborts generation and stops audio when the learner interrupts', async () => {
    const synth = new FakeSynthesizer(false);
    const { session, vad, model, synthesizer } = build({ synth });
    const started = session.start();
    await flush();

    model.push('Tell me about the migration you led. ');
    await flush();
    expect(session.state).toBe('speaking');

    clock += 1000; // past the AEC guard window
    vad.speechStart();
    await started;

    expect(synthesizer.stopCalls).toBe(1);
    expect(model.aborted).toBe(true);
    expect(session.state).toBe('listening');
  });

  it('records only what was actually spoken aloud', async () => {
    const synth = new FakeSynthesizer(false);
    const { session, vad, model } = build({ synth });
    const started = session.start();
    await flush();

    model.push('First question here. ');
    await flush();
    clock += 1000;
    vad.speechStart();
    await started;

    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]?.text).toBe('First question here.');
    expect(session.turns[0]?.bargedIn).toBe(true);
  });

  it('ignores echo of its own voice inside the guard window', async () => {
    const synth = new FakeSynthesizer(false);
    const { session, vad, model, synthesizer } = build({ synth });
    const started = session.start();
    await flush();

    model.push('Tell me about the migration you led. ');
    await flush();

    clock += 100; // well inside BARGE_IN_GUARD_MS
    vad.speechStart();
    await flush();

    expect(synthesizer.stopCalls).toBe(0);
    expect(model.aborted).toBe(false);

    synth.release();
    model.finish();
    await started;
  });

  it('does not treat speech as barge-in while merely listening', async () => {
    const { session, vad, model, synthesizer } = build();
    const started = session.start();
    await flush();
    model.script('A first question about your work.');
    await started;

    expect(session.state).toBe('listening');
    vad.speechStart();
    expect(synthesizer.stopCalls).toBe(0);
  });
});

describe('InterviewSession learner turns', () => {
  it('appends the transcript and maps roles for the model', async () => {
    const { session, vad, model } = build({ transcripts: ['I rebuilt the billing pipeline.'] });
    const started = session.start();
    await flush();
    model.script('Walk me through a system you owned.');
    await started;

    const next = vad.speechEnd();
    await flush();
    model.script('What did that change in numbers?');
    await next;
    await flush();

    const messages = model.receivedMessages[1]!;
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user']);
    expect(messages[2]?.content).toBe('I rebuilt the billing pipeline.');
  });

  it('discards a near-empty transcript instead of starting a turn', async () => {
    const { session, vad, model } = build({ transcripts: ['.'] });
    const started = session.start();
    await flush();
    model.script('Walk me through a system you owned.');
    await started;

    await vad.speechEnd();

    expect(session.turns).toHaveLength(1);
    expect(model.receivedMessages).toHaveLength(1);
    expect(session.state).toBe('listening');
  });
});

describe('InterviewSession realtime behaviour', () => {
  it('warms the model up before opening the microphone', async () => {
    const { session, model, vad } = build();
    const order: string[] = [];
    model.warmUp = async () => void order.push('warmUp');
    const realStart = vad.start.bind(vad);
    vad.start = async (h) => {
      order.push('vad.start');
      return realStart(h);
    };

    const started = session.start();
    await flush();
    model.script('An opening question about your work.');
    await started;

    expect(order).toEqual(['warmUp', 'vad.start']);
  });

  it('starts audio at a clause boundary before the first sentence completes', async () => {
    const { session, model, synthesizer } = build();
    const started = session.start();
    await flush();

    // No terminal punctuation yet — without clause breaking this is silence.
    model.push('Thanks for making the time, ');
    await flush();
    expect(synthesizer.spoken).toEqual(['Thanks for making the time,']);

    model.push('walk me through a system you owned. ');
    model.finish();
    await started;
  });

  it('reverts to sentence boundaries once the turn is already speaking', async () => {
    const { session, model, synthesizer } = build();
    const started = session.start();
    await flush();

    model.push('Thanks for making the time, ');
    await flush();
    model.push('and welcome, ');
    await flush();
    // The second clause is held: audio is already playing, so prosody wins.
    expect(synthesizer.spoken).toEqual(['Thanks for making the time,']);

    model.push('walk me through the migration. ');
    await flush();
    expect(synthesizer.spoken).toEqual([
      'Thanks for making the time,',
      'and welcome, walk me through the migration.',
    ]);

    model.finish();
    await started;
  });

  it('tolerates a model with no warm-up support', async () => {
    const { session, model } = build();
    expect(model.warmUp).toBeUndefined();
    const started = session.start();
    await flush();
    model.script('An opening question about your work.');
    await expect(started).resolves.toBeUndefined();
  });
});

describe('InterviewSession lifecycle', () => {
  it('ends and releases the microphone at the turn budget', async () => {
    const { session, vad, model } = build();
    const started = session.start();
    await flush();
    model.script('Question one about your work.');
    await started;

    for (let i = 0; i < 2; i += 1) {
      const turn = vad.speechEnd();
      await flush();
      model.script(`Follow up number ${i} about the details.`);
      await turn;
      await flush();
    }

    expect(session.state).toBe('ended');
    expect(vad.destroyed).toBe(true);
  });

  it('surfaces a synthesiser fault without killing the speech queue', async () => {
    const { session, model, synthesizer } = build();
    const errors: Error[] = [];
    vi.spyOn(synthesizer, 'speak').mockRejectedValueOnce(new Error('audio device lost'));

    const started = session.start();
    session.on('error', (e) => errors.push(e));
    await flush();

    model.push('First sentence here. ');
    await flush();
    model.push('Second sentence here. ');
    model.finish();
    await started;

    expect(errors.map((e) => e.message)).toEqual(['audio device lost']);
    expect(synthesizer.spoken).toContain('Second sentence here.');
  });
});
