import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, type Auth, type User } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

/**
 * Firebase is optional.
 *
 * With no config the app runs entirely local: bundled scenarios, learner state
 * in localStorage, on-device inference, nothing leaves the machine. That is not
 * a demo mode — it is the privacy posture the product is built around, and the
 * backend only adds cross-device sync and the opt-in cloud model route.
 *
 * Every caller must therefore handle `undefined` rather than assuming a backend.
 */
export interface Backend {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

let backend: Backend | undefined;
let initialised = false;

export function getBackend(): Backend | undefined {
  if (initialised) return backend;
  initialised = true;

  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };

  if (!config.apiKey || !config.projectId) return undefined;

  const app = initializeApp(config);
  backend = { app, auth: getAuth(app), db: getFirestore(app) };
  return backend;
}

/**
 * Anonymous sign-in.
 *
 * Deliberately anonymous by default: practising job interviews is sensitive, and
 * requiring an identity to do it is a barrier we have no reason to impose.
 * A portal deployment swaps this for the host's SSO token exchange.
 */
export async function ensureUser(): Promise<User | undefined> {
  const b = getBackend();
  if (!b) return undefined;
  if (b.auth.currentUser) return b.auth.currentUser;
  const credential = await signInAnonymously(b.auth);
  return credential.user;
}
