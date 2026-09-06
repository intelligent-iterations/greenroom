import {
  LearnerState,
  updateMastery,
  type CompetencyId,
  type SessionRecord,
} from '@greenroom/shared';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { ensureUser, getBackend } from '../data/firebase.js';

/**
 * The learner-state layer.
 *
 * Reads and writes go through here so the rest of the app never cares whether
 * state lives in localStorage or Firestore. Local is the source of truth for a
 * session in flight; Firestore is sync, not a dependency, because a dropped
 * network must not end an interview.
 */
const STORAGE_KEY = 'greenroom.learner.v1';

export function defaultLearnerState(userId: string): LearnerState {
  return {
    userId,
    cefr: 'B2',
    seniority: 'mid',
    language: 'en',
    targetRole: 'Backend Engineer',
    mastery: [],
    recentErrors: [],
    sessionsCompleted: 0,
    updatedAt: Date.now(),
    documents: [],
  };
}

function readLocal(): LearnerState | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    // Parsed through zod: a stale shape from an older release would otherwise
    // reach the prompt compiler and produce a subtly miscalibrated interview.
    const parsed = LearnerState.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeLocal(state: LearnerState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing or a full quota. State stays in memory for this session.
  }
}

export async function loadLearnerState(): Promise<LearnerState> {
  const local = readLocal();
  const backend = getBackend();

  if (!backend) return local ?? defaultLearnerState('local');

  try {
    const user = await ensureUser();
    if (!user) return local ?? defaultLearnerState('local');

    const snapshot = await getDoc(doc(backend.db, 'learners', user.uid));
    const remote = snapshot.exists() ? LearnerState.safeParse(snapshot.data()) : undefined;

    // Last-write-wins on `updatedAt`. Sessions are minutes long and a learner
    // is on one device at a time, so the merge complexity is not earned.
    if (remote?.success && (!local || remote.data.updatedAt > local.updatedAt)) {
      writeLocal(remote.data);
      return remote.data;
    }
    return local ?? defaultLearnerState(user.uid);
  } catch {
    // Offline or rules rejection. Local state is still perfectly usable.
    return local ?? defaultLearnerState('local');
  }
}

export async function saveLearnerState(state: LearnerState): Promise<void> {
  writeLocal(state);
  const backend = getBackend();
  if (!backend) return;
  try {
    const user = await ensureUser();
    if (!user) return;
    // `documents` is deliberately dropped here, not merely left unread. A
    // pasted CV is the most identifying thing this product handles and it stays
    // on the device that holds it; firestore.rules rejects a learner write
    // carrying the field, so sending it would silently break sync as well as
    // breaking the promise — the catch below would swallow the rejection and
    // nobody would learn that state had stopped syncing.
    const { documents: _localOnly, ...syncable } = state;
    await setDoc(doc(backend.db, 'learners', user.uid), { ...syncable, userId: user.uid });
  } catch {
    // Sync is best-effort by design; local already holds the truth.
  }
}

/**
 * Fold a completed session's scores into the learner's mastery estimates.
 *
 * Only the competencies the session actually trained are updated. Scoring every
 * competency from one interview would let a strong answer on storytelling drag
 * up an estimate for, say, technical depth that the session never probed.
 */
export function applySessionOutcome(
  state: LearnerState,
  scores: Array<{ competency: CompetencyId; score: number }>,
  now = Date.now(),
): LearnerState {
  const mastery = [...state.mastery];

  for (const { competency, score } of scores) {
    const index = mastery.findIndex((m) => m.competency === competency);
    const updated = updateMastery(competency, mastery[index], score, now);
    if (index >= 0) mastery[index] = updated;
    else mastery.push(updated);
  }

  return {
    ...state,
    mastery,
    sessionsCompleted: state.sessionsCompleted + 1,
    updatedAt: now,
  };
}

/** Persists a finished session transcript when a backend is configured. */
export async function saveSession(record: SessionRecord): Promise<void> {
  const backend = getBackend();
  if (!backend) return;
  try {
    const user = await ensureUser();
    if (!user) return;
    await setDoc(doc(backend.db, 'learners', user.uid, 'sessions', record.id), {
      ...record,
      userId: user.uid,
    });
  } catch {
    // Non-fatal: the debrief is already on screen.
  }
}
