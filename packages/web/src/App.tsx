import { useEffect } from 'react';
import { AccountBar } from './components/AccountBar.js';
import { DebriefScreen } from './components/DebriefScreen.js';
import { SessionScreen } from './components/SessionScreen.js';
import { SetupScreen } from './components/SetupScreen.js';
import { loadLearnerState } from './state/learner.js';
import { useAppStore } from './state/store.js';
import { useSession } from './state/useSession.js';

export function App() {
  const phase = useAppStore((s) => s.phase);
  const learner = useAppStore((s) => s.learner);
  const setLearner = useAppStore((s) => s.setLearner);
  const session = useSession();

  useEffect(() => {
    void loadLearnerState().then(setLearner);
  }, [setLearner]);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__mark" aria-hidden="true" />
        <h1>Greenroom</h1>
        <p className="app__tagline">Interview practice that never leaves your device</p>
        {phase === 'setup' && <AccountBar />}
      </header>

      <main>
        {!learner ? (
          <p className="muted">Loading your profile…</p>
        ) : phase === 'setup' ? (
          <SetupScreen learner={learner} session={session} />
        ) : phase === 'live' ? (
          <SessionScreen session={session} />
        ) : (
          <DebriefScreen learner={learner} session={session} />
        )}
      </main>
    </div>
  );
}
