import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/firestore';
import { onRequest } from 'firebase-functions/https';
import { setGlobalOptions } from 'firebase-functions';
import {
  SessionRecord,
} from '@greenroom/shared';
import {
  LearnerState,
  compileInterviewerPrompt,
} from '@greenroom/shared/interview';
import { handleGenerate } from './generate.js';
import { foldScores, scoreSession } from './scoring.js';
import { findScenario } from './scenarios.js';

initializeApp();

/**
 * Montreal region.
 *
 * The client is Canadian-federal-adjacent and the on-device story only holds if
 * the parts that are not on-device stay in-country. northamerica-northeast1 is
 * Montreal; it is the default for every function here, not a per-function
 * decision someone can forget to make.
 */
setGlobalOptions({ region: 'northamerica-northeast1', maxInstances: 20 });

/**
 * Streaming cloud inference. Only reached when a learner opts in.
 *
 * `invoker: "public"` opens the Cloud Run service to unauthenticated
 * *invocation*; it does not make the endpoint unauthenticated. The browser has
 * no Google credentials to present, so platform-level IAM cannot be the gate —
 * `handleGenerate` verifies a Firebase ID token and returns 401 without one.
 * Declaring it here rather than granting run.invoker by hand keeps a clean
 * redeploy from silently landing a function no browser can reach.
 */
export const generate = onRequest(
  { cors: true, timeoutSeconds: 120, invoker: 'public' },
  handleGenerate,
);

/**
 * Scores a session and updates the learner's mastery estimates.
 *
 * Triggered on write rather than called by the client so scoring cannot be
 * skipped, replayed, or supplied. The learner already has their feedback on
 * screen by now — this is the slow, authoritative path behind it.
 */
export const onSessionCreated = onDocumentCreated(
  { document: 'learners/{uid}/sessions/{sessionId}', timeoutSeconds: 120 },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const parsedSession = SessionRecord.safeParse(data);
    if (!parsedSession.success) {
      console.error('malformed session document', {
        sessionId: event.params.sessionId,
        issues: parsedSession.error.issues.slice(0, 5),
      });
      return;
    }
    const session = parsedSession.data;

    const scenario = findScenario(session.scenarioId);
    if (!scenario) {
      console.error('unknown scenario', { scenarioId: session.scenarioId });
      return;
    }

    const db = getFirestore();
    const learnerRef = db.doc(`learners/${event.params.uid}`);
    const snapshot = await learnerRef.get();
    const parsedLearner = LearnerState.safeParse(snapshot.data());
    if (!parsedLearner.success) {
      console.error('learner document missing or malformed', { uid: event.params.uid });
      return;
    }

    // Recompiled rather than read off the session: the focus competencies are
    // whatever the prompt layer chose for this learner, and deriving them the
    // same way twice keeps scoring aligned with what was actually trained.
    const { focus } = compileInterviewerPrompt({
      scenario,
      learner: parsedLearner.data,
    });

    const scores = await scoreSession(scenario, focus, session.turns);
    if (scores.length === 0) return;

    await learnerRef.set(foldScores(parsedLearner.data, scores, Date.now()), { merge: true });

    console.info(
      JSON.stringify({
        event: 'session_scored',
        uid: event.params.uid,
        sessionId: event.params.sessionId,
        promptVersion: session.promptVersion,
        modelId: session.modelId,
        scores: scores.map((s) => ({ c: s.competency, s: s.score })),
      }),
    );
  },
);
