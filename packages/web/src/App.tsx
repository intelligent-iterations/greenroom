import { useEffect } from 'react';
import { AccountBar } from './components/AccountBar.js';
import { DebriefScreen } from './components/DebriefScreen.js';
import { EvalsScreen } from './components/EvalsScreen.js';
import { SessionScreen } from './components/SessionScreen.js';
import { SetupScreen } from './components/SetupScreen.js';
import { Nav } from './components/Nav.js';
import { RealtimeScreen } from './components/RealtimeScreen.js';
import { loadLearnerState } from './state/learner.js';
import { useAppStore } from './state/store.js';
import { useSession } from './state/useSession.js';

export function App() {
  const phase = useAppStore((s) => s.phase);
  const learner = useAppStore((s) => s.learner);
  const setLearner = useAppStore((s) => s.setLearner);
  const setPhase = useAppStore((s) => s.setPhase);
  const session = useSession();

  useEffect(() => {
    void loadLearnerState().then(setLearner);
  }, [setLearner]);

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__mark" aria-hidden="true" />
        <h1>Greenroom</h1>
        <p className="app__tagline">
          A playground for realtime voice models that run on your device
        </p>
        {phase === 'setup' && <AccountBar />}
      </header>

      {/* Rendered outside <main> so it is a sibling of the content it switches,
          not part of it. */}
      <Nav
        phase={phase}
        onNavigate={(to) =>
          setPhase(to === 'evals' ? 'evals' : to === 'realtime' ? 'realtime' : 'setup')
        }
      />

      <main>
        {!learner ? (
          <p className="muted">Loading your profile…</p>
        ) : phase === 'setup' ? (
          <SetupScreen learner={learner} session={session} />
        ) : phase === 'live' ? (
          <SessionScreen session={session} />
        ) : phase === 'realtime' ? (
          <RealtimeScreen />
        ) : phase === 'evals' ? (
          <EvalsScreen onExit={() => setPhase('setup')} />
        ) : (
          <DebriefScreen learner={learner} session={session} />
        )}
      </main>
    </div>
  );
}
