import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Tests for firestore.rules.
 *
 * These rules are the only thing standing between a learner and their own
 * mastery estimates. Those estimates decide what the interviewer asks next, so
 * a client that could write them could choose its own difficulty — and the
 * whole point of scoring server-side would be lost.
 *
 * That boundary was asserted in a comment and never exercised. It is exercised
 * here, and the suite blocks CI, because a security rule nobody tests is a
 * security rule nobody knows the state of.
 */
let testEnv: RulesTestEnvironment;

const ALICE = 'alice';
const BOB = 'bob';

/** A learner document in the shape the app writes. */
function learnerDoc(userId: string, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function sessionDoc(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    userId,
    scenarioId: 'backend-mid-en',
    startedAt: Date.now(),
    turns: [{ id: 't1', role: 'interviewer', text: 'Hello.', startedAt: Date.now() }],
    modelId: 'test',
    promptVersion: 'test',
    ...overrides,
  };
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'greenroom-test',
    firestore: {
      rules: readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

afterAll(async () => testEnv?.cleanup());
beforeEach(async () => testEnv.clearFirestore());

describe('learner profile ownership', () => {
  it('lets a learner create their own profile', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(setDoc(doc(db, 'learners', ALICE), learnerDoc(ALICE)));
  });

  it('refuses a profile created under someone else id', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(setDoc(doc(db, 'learners', BOB), learnerDoc(BOB)));
  });

  it('refuses a profile whose userId does not match the document id', async () => {
    // Otherwise a learner could write a document that the scoring trigger
    // attributes to somebody else.
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(setDoc(doc(db, 'learners', ALICE), learnerDoc(BOB)));
  });

  it('refuses an unauthenticated write', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'learners', ALICE), learnerDoc(ALICE)));
  });

  it('lets a learner read their own profile and nobody else read it', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'learners', ALICE), learnerDoc(ALICE));
    });

    const alice = testEnv.authenticatedContext(ALICE).firestore();
    const bob = testEnv.authenticatedContext(BOB).firestore();
    await assertSucceeds(getDoc(doc(alice, 'learners', ALICE)));
    await assertFails(getDoc(doc(bob, 'learners', ALICE)));
  });
});

describe('server-owned fields', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'learners', ALICE), learnerDoc(ALICE));
    });
  });

  it('refuses a profile created with mastery already filled in', async () => {
    await testEnv.clearFirestore();
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(
      setDoc(
        doc(db, 'learners', ALICE),
        learnerDoc(ALICE, {
          mastery: [{ competency: 'concision', score: 1, observations: 99, updatedAt: 0 }],
        }),
      ),
    );
  });

  it('refuses a profile created with a non-zero session count', async () => {
    await testEnv.clearFirestore();
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(setDoc(doc(db, 'learners', ALICE), learnerDoc(ALICE, { sessionsCompleted: 50 })));
  });

  it.each(['mastery', 'recentErrors', 'sessionsCompleted'])(
    'refuses a client update to %s',
    async (field) => {
      // The core of the boundary: these drive what the learner is asked next.
      const db = testEnv.authenticatedContext(ALICE).firestore();
      const value =
        field === 'sessionsCompleted'
          ? 999
          : field === 'mastery'
            ? [{ competency: 'concision', score: 1, observations: 99, updatedAt: 0 }]
            : [{ competency: 'concision', note: 'x', occurrences: 1, lastSeenAt: 0 }];
      await assertFails(updateDoc(doc(db, 'learners', ALICE), { [field]: value }));
    },
  );

  it('allows a learner to change their own preferences', async () => {
    // Level and target role are theirs; only the scored fields are not.
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'learners', ALICE), { cefr: 'C1', targetRole: 'Staff Engineer' }),
    );
  });

  it('refuses a preference change that smuggles a mastery edit alongside it', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(
      updateDoc(doc(db, 'learners', ALICE), {
        cefr: 'C1',
        mastery: [{ competency: 'concision', score: 1, observations: 99, updatedAt: 0 }],
      }),
    );
  });

  it('lets the server write scored fields', async () => {
    // The trigger runs with Admin credentials, which bypass rules entirely.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(
        updateDoc(doc(ctx.firestore(), 'learners', ALICE), { sessionsCompleted: 3 }),
      );
    });
  });
});

describe('session transcripts', () => {
  it('lets a learner create their own session', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(setDoc(doc(db, 'learners', ALICE, 'sessions', 's1'), sessionDoc(ALICE)));
  });

  it('refuses a session written into another learner subtree', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(setDoc(doc(db, 'learners', BOB, 'sessions', 's1'), sessionDoc(BOB)));
  });

  it('refuses a session whose userId does not match the owner', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(setDoc(doc(db, 'learners', ALICE, 'sessions', 's1'), sessionDoc(BOB)));
  });

  it('is append-only: no updates and no deletes', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'learners', ALICE, 'sessions', 's1'), sessionDoc(ALICE));
    });

    // A transcript that can be edited after the fact is not evidence, and the
    // scoring trigger reads it as evidence.
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(updateDoc(doc(db, 'learners', ALICE, 'sessions', 's1'), { turns: [] }));
    await assertFails(deleteDoc(doc(db, 'learners', ALICE, 'sessions', 's1')));
  });

  it('caps the number of turns in one session', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    const turns = Array.from({ length: 101 }, (_, i) => ({
      id: `t${i}`,
      role: 'learner',
      text: 'x',
      startedAt: 0,
    }));
    await assertFails(
      setDoc(doc(db, 'learners', ALICE, 'sessions', 'big'), sessionDoc(ALICE, { turns })),
    );
  });

  it('lets a learner read only their own sessions', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'learners', ALICE, 'sessions', 's1'), sessionDoc(ALICE));
    });

    const alice = testEnv.authenticatedContext(ALICE).firestore();
    const bob = testEnv.authenticatedContext(BOB).firestore();
    await assertSucceeds(getDocs(collection(alice, 'learners', ALICE, 'sessions')));
    await assertFails(getDocs(collection(bob, 'learners', ALICE, 'sessions')));
  });
});

describe('learner documents never reach the server', () => {
  const cv = [{ id: 'cv-1', kind: 'cv', title: 'CV', text: 'Led the Kafka migration.', updatedAt: 0 }];

  // A pasted CV is the most identifying thing this product handles, and the
  // design says it stays on the device. The client is written not to send it;
  // these two tests are what make that a guarantee rather than a promise.
  it('refuses a profile created with documents attached', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(setDoc(doc(db, 'learners', ALICE), learnerDoc(ALICE, { documents: cv })));
  });

  it('refuses an update that adds documents to an existing profile', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'learners', ALICE), learnerDoc(ALICE));
    });
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(updateDoc(doc(db, 'learners', ALICE), { documents: cv }));
  });

  it('still allows a profile with no documents field at all', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(setDoc(doc(db, 'learners', ALICE), learnerDoc(ALICE)));
  });

  // Passage *references* are fine: they name a scenario note or a chunk index,
  // never the document text.
  it('accepts a session carrying passage references', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'learners', ALICE, 'sessions', 's1'),
        sessionDoc(ALICE, {
          groundedPassages: [{ sourceId: 'scenario:backend-mid-en', chunkIndex: 0 }],
        }),
      ),
    );
  });

  it('caps how many passage references one session may carry', async () => {
    const db = testEnv.authenticatedContext(ALICE).firestore();
    const tooMany = Array.from({ length: 41 }, (_, i) => ({ sourceId: 'doc:cv-1', chunkIndex: i }));
    await assertFails(
      setDoc(doc(db, 'learners', ALICE, 'sessions', 's1'), sessionDoc(ALICE, { groundedPassages: tooMany })),
    );
  });
});

describe('everything else is closed', () => {
  it('refuses reads and writes outside the learner tree', async () => {
    // The catch-all deny. Without it, a future collection is open by default.
    const db = testEnv.authenticatedContext(ALICE).firestore();
    await assertFails(setDoc(doc(db, 'anythingElse', 'x'), { a: 1 }));
    await assertFails(getDoc(doc(db, 'anythingElse', 'x')));
  });
});

it('the rules file under test is the one that ships', () => {
  // Guards against the suite quietly testing a copy.
  const rules = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8');
  expect(rules).toContain('serverOwnedFields');
  expect(rules).toContain("match /learners/{uid}");
});
