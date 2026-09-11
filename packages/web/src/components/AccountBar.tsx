import { useEffect, useState } from 'react';
import {
  continueAnonymously,
  describeAuthError,
  signIn,
  signOutUser,
  signUp,
  watchAuth,
  type AuthState,
} from '../data/auth.js';

/**
 * Account controls, deliberately understated.
 *
 * Signing in buys one thing — progress that follows you between devices — so it
 * is presented as an option in the corner rather than a gate in front of the
 * product. A learner who ignores this entirely gets the full experience.
 */
export function AccountBar() {
  const [auth, setAuth] = useState<AuthState>({ user: undefined, mode: 'local-only' });
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => watchAuth(setAuth), []);

  // Establish an anonymous session so sessions can sync, without ever asking.
  useEffect(() => {
    if (auth.mode === 'local-only') void continueAnonymously().catch(() => {});
  }, [auth.mode]);

  async function attempt(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setOpen(false);
      setPassword('');
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  if (auth.mode === 'signed-in') {
    return (
      <div className="account">
        <span className="muted small">{auth.user?.email}</span>
        <button type="button" className="link" onClick={() => void signOutUser()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="account">
      {!open ? (
        <button type="button" className="link" onClick={() => setOpen(true)}>
          Save my progress
        </button>
      ) : (
        <form
          className="account__form"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(() => signUp(email, password));
          }}
        >
          <p className="muted small">
            Optional. Your practice runs on this device either way — an account only
            carries your progress to another one.
          </p>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (6+ characters)"
            autoComplete="current-password"
            minLength={6}
            required
          />
          {error && <p className="error small">{error}</p>}
          <div className="row">
            <button type="submit" className="primary small-btn" disabled={busy}>
              {busy ? 'Working…' : 'Create account'}
            </button>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => void attempt(() => signIn(email, password))}
            >
              I already have one
            </button>
            <button type="button" className="link" onClick={() => setOpen(false)}>
              Not now
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
