import {
  DEFAULT_POLICY,
  findScenario,
  selectModel,
  type LearnerState,
  type RoutingDecision,
} from '@greenroom/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureUser } from '../data/firebase.js';
import { detectCapabilities, type DeviceCapabilities } from '../voice/capabilities.js';
import { MODEL_CATALOGUE } from '../voice/models.js';
import { InterviewSession } from '../voice/session.js';
import { WebSpeechSynthesizer } from '../voice/tts-webspeech.js';
import { useAppStore } from './store.js';

/**
 * Wires an InterviewSession into React.
 *
 * The session outlives renders and is held in a ref; React only ever observes
 * it through the store. Nothing here touches the pipeline's internals, which is
 * what keeps the voice loop testable without a DOM.
 */
export function useSession() {
  const sessionRef = useRef<InterviewSession | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<DeviceCapabilities>();
  const [routing, setRouting] = useState<RoutingDecision>();
  const store = useAppStore();

  useEffect(() => {
    void detectCapabilities().then(setCapabilities);
  }, []);

  // Recomputed whenever the device or the learner's cloud consent changes, so
  // the setup screen can explain the choice before anything is downloaded.
  useEffect(() => {
    if (!capabilities) return;
    const policy = store.allowCloud
      ? { ...DEFAULT_POLICY, requireOnDevice: false, allowedResidencies: [], preferQuality: true }
      : DEFAULT_POLICY;
    setRouting(
      selectModel(MODEL_CATALOGUE, policy, {
        hasWebGpu: capabilities.hasWebGpu,
        online: navigator.onLine,
      }),
    );
  }, [capabilities, store.allowCloud]);

  const start = useCallback(
    async (learner: LearnerState) => {
      const scenario = findScenario(useAppStore.getState().scenarioId);
      const selected = routing?.selected;
      if (!scenario) return store.setError('That scenario is no longer available.');
      if (!selected) {
        return store.setError(
          'This device cannot run a private session and cloud inference is turned off. Turn on cloud inference, or try a browser with WebGPU.',
        );
      }

      store.resetSession();

      // Every heavy adapter is imported here rather than at module scope.
      // Statically, transformers.js + WebLLM + Kokoro are about 9 MB of
      // JavaScript, which would be downloaded before the setup screen could
      // render a button. Deferring them to the moment a session actually
      // starts keeps first paint to the shell, and the cloud path never pays
      // for the on-device runtimes it does not use.
      const model = selected.vendor === 'on-device'
        ? await import('../voice/llm-webllm.js').then(
            (m) => new m.WebLlmModel({ model: selected.id }),
          )
        : await import('../voice/llm-cloud.js').then(
            (m) =>
              new m.CloudLanguageModel({
                model: selected.id,
                endpoint: '/api/generate',
                getAuthToken: async () => (await ensureUser())?.getIdToken(),
              }),
          );

      // Kokoro when the GPU can carry it AND the scenario is English — v1.0
      // has no French voice, and on WASM it competes with Whisper for the same
      // threads and pushes first-audio past two seconds, which is worse for the
      // learner than a plainer platform voice.
      const useNeuralVoice = capabilities?.hasWebGpu && scenario.language === 'en';
      const synthesizer = useNeuralVoice
        ? await import('../voice/tts-kokoro.js').then((m) => new m.KokoroSynthesizer())
        : new WebSpeechSynthesizer({ language: scenario.language });

      const { WhisperRecognizer } = await import('../voice/stt-whisper.js');

      const session = new InterviewSession({
        scenario,
        learner,
        stages: {
          recognizer: new WhisperRecognizer({ language: scenario.language }),
          model,
          synthesizer,
        },
      });

      session.on('state', store.setSessionState);
      session.on('turn', store.addTurn);
      session.on('interviewerDelta', store.setLiveText);
      session.on('timings', store.addLatency);
      session.on('progress', store.setProgress);
      session.on('error', (err) => store.setError(err.message));

      sessionRef.current = session;
      store.setPhase('live');
      await session.start();
    },
    [capabilities, routing, store],
  );

  const stop = useCallback(async () => {
    await sessionRef.current?.end();
    store.setPhase('debrief');
  }, [store]);

  // A session holds the microphone and ~1GB of GPU memory. Leaving it alive
  // across an unmount is the difference between a tab you can leave open and
  // one that eats the machine.
  useEffect(() => {
    return () => {
      void sessionRef.current?.dispose();
      sessionRef.current = undefined;
    };
  }, []);

  return { start, stop, capabilities, routing, session: sessionRef.current };
}
