import {
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  linkWithCredential,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import { getBackend } from './firebase.js';

/**
 * Authentication.
 *
 * Anonymous by default and deliberately so: practising job interviews is
 * sensitive, and requiring an identity to do it is a barrier with no
 * justification. Signing in is for one thing only — keeping progress across
 * devices — so it is offered, never demanded.
 *
 * When an anonymous learner does sign up, the account is *upgraded in place*
 * with `linkWithCredential` rather than replaced. Creating a fresh account
 * would orphan every session and mastery estimate they had already built up,
 * which is the moment a learner is least willing to forgive losing them.
 */
export type AuthMode = 'anonymous' | 'signed-in' | 'local-only';

export interface AuthState {
  user: User | undefined;
  mode: AuthMode;
  /** Present when the last attempt failed, in language a learner can act on. */
  error?: string;
}

export function watchAuth(onChange: (state: AuthState) => void): () => void {
  const backend = getBackend();
  if (!backend) {
    // No Firebase configured: the app still works, entirely on-device.
    onChange({ user: undefined, mode: 'local-only' });
    return () => {};
  }

  return onAuthStateChanged(backend.auth, (user) => {
    onChange({
      user: user ?? undefined,
      mode: !user ? 'local-only' : user.isAnonymous ? 'anonymous' : 'signed-in',
    });
  });
}

export async function continueAnonymously(): Promise<void> {
  const backend = getBackend();
  if (!backend) return;
  if (backend.auth.currentUser) return;
  await signInAnonymously(backend.auth);
}

/**
 * Turns an anonymous account into a permanent one, preserving its history.
 *
 * Falls back to creating a new account only when there is no anonymous session
 * to upgrade, or when the address already belongs to someone.
 */
export async function signUp(email: string, password: string): Promise<void> {
  const backend = getBackend();
  if (!backend) throw new Error('No backend configured');

  const current = backend.auth.currentUser;
  const credential = EmailAuthProvider.credential(email, password);

  if (current?.isAnonymous) {
    try {
      await linkWithCredential(current, credential);
      return;
    } catch (err) {
      // Already registered: fall through to a normal sign-in below, which is
      // what the learner almost certainly meant.
      if ((err as { code?: string }).code !== 'auth/email-already-in-use') throw err;
      await signInWithEmailAndPassword(backend.auth, email, password);
      return;
    }
  }

  await createUserWithEmailAndPassword(backend.auth, email, password);
}

export async function signIn(email: string, password: string): Promise<void> {
  const backend = getBackend();
  if (!backend) throw new Error('No backend configured');
  await signInWithEmailAndPassword(backend.auth, email, password);
}

export async function signOutUser(): Promise<void> {
  const backend = getBackend();
  if (!backend) return;
  await signOut(backend.auth);
}

/** Firebase error codes are not sentences. Turn them into ones. */
export function describeAuthError(err: unknown): string {
  const code = (err as { code?: string }).code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That does not look like an email address.';
    case 'auth/weak-password':
      return 'Passwords need to be at least six characters.';
    case 'auth/email-already-in-use':
      return 'That email already has an account. Try signing in instead.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return 'That email and password do not match.';
    case 'auth/user-not-found':
      return 'No account with that email yet.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'Could not reach the server. Your practice still works offline.';
    default:
      return 'Could not sign in. Your practice still works without an account.';
  }
}
