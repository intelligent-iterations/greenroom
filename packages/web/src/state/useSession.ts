import { ensureUser } from '../data/firebase.js';
import {
  BUILT_IN_PRESETS,
  customPreset,
  DEFAULT_POLICY,
  LexicalRetriever,
  NON_LLM_STAGE_VRAM_MB,
  buildCorpus,
  selectModel,
  type Retriever,
  type RoutingDecision,
  type RoutingPolicy,
} from '@greenroom/shared';
import {
  interviewPreset,
  findScenario,
  type LearnerState,
} from '@greenroom/shared/interview';
import { useCallback, useEffect, useRef, useState } from 'react';
import { detectCapabilities, type DeviceCapabilities } from '../voice/capabilities.js';
import { MODEL_CATALOGUE } from '../voice/models.js';
import { InterviewSession } from '../voice/session.js';
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

    // What is left for the interviewer model once the recogniser and the voice
    // have taken their share of the same GPU. Undefined when the device gives
    // us nothing to go on, in which case the router does not filter on memory
    // and WebLLM's own load-time check becomes the backstop.
    const vramBudgetMb =
      capabilities.maxBufferMb === undefined
        ? undefined
        : Math.max(0, capabilities.maxBufferMb - NON_LLM_STAGE_VRAM_MB);

    const base: RoutingPolicy = store.allowCloud
      ? { ...DEFAULT_POLICY, requireOnDevice: false, allowedResidencies: [], preferQuality: true }
      : { ...DEFAULT_POLICY, preferQuality: true };

    // An explicit choice wins over the policy's preference, but still has to
    // clear the hard constraints — a learner cannot pick a model that will not
    // fit in their GPU.
    const chosen = store.modelId
      ? MODEL_CATALOGUE.filter((m) => m.id === store.modelId)
      : MODEL_CATALOGUE;

    setRouting(
      selectModel(
        chosen,
        {
          ...base,
          ...(vramBudgetMb !== undefined ? { vramBudgetMb } : {}),
          // A deliberately chosen model should not be rejected for being a
          // little slower than the automatic pick would tolerate.
          ...(store.modelId ? { maxFirstTokenMs: 4000 } : {}),
        },
        { hasWebGpu: capabilities.hasWebGpu, online: navigator.onLine },
      ),
    );
  }, [capabilities, store.allowCloud, store.modelId]);

  const start = useCallback(
    async (learner: LearnerState) => {
      const app = useAppStore.getState();
      const selected = routing?.selected;

      // Resolve who the model is playing. Interview presets go through the
      // pedagogical compiler; everything else is a literal prompt.
      const preset = app.presetId.startsWith('interview:')
        ? interviewPreset(app.presetId.slice('interview:'.length), learner)
        : app.presetId === 'custom'
          ? customPreset(app.customPrompt)
          : BUILT_IN_PRESETS.find((p) => p.id === app.presetId);

      if (!preset) return store.setError('That conversation partner is unavailable.');

      // The checks and the debrief still want a scenario; the interview presets
      // carry one, and the generic partners borrow the first as a stand-in.
      const scenario =
        findScenario(app.presetId.replace('interview:', '')) ?? findScenario('backend-mid-en');
      if (!scenario) return store.setError('Scenario catalogue is empty.');
      if (!selected) {
        return store.setError(
          'This device cannot run a private session and cloud inference is turned off. Turn on cloud inference, or try a browser with WebGPU.',
        );
      }

      store.resetSession();

      // All three models run in one worker. Keeping inference off the main
      // thread is what makes barge-in possible at all: while the main thread is
      // blocked the VAD cannot deliver a speech event, so the learner cannot
      // interrupt. Imported lazily so the setup screen does not pay for it.
      const { InferencePipeline } = await import('../voice/pipeline-worker.js');
      const onDevice = selected.vendor === 'on-device';
      const pipeline = new InferencePipeline(
        preset.language,
        onDevice ? (app.customModelRepo ?? selected.id) : undefined,
        app.localModelFiles,
      );

      // Even on the cloud route, recognition and the voice stay on this device.
      // Only the transcript leaves — never the audio. That is a meaningful
      // difference: a recording of someone's voice is biometric data, a
      // transcript is text, and they do not carry the same obligations.
      const languageModel = onDevice
        ? pipeline.model
        : await import('../voice/llm-cloud.js').then(
            (m) =>
              new m.CloudLanguageModel({
                model: selected.id,
                endpoint: '/api/generate',
                getAuthToken: async () => (await ensureUser())?.getIdToken(),
              }),
          );

      // Called synchronously enough after the button click to still count as a
      // user gesture. Without this the AudioContext stays suspended and the
      // interviewer is inaudible, with nothing logged to explain why.
      await pipeline.primeAudio();

      // Grounding, when the learner pasted something. Indexed here rather than
      // in the session because the corpus comes from the scenario and the
      // learner's own documents, and the orchestrator should know about
      // neither. Skipped entirely when there is nothing to ground in, so the
      // prompt compiler falls back to the scenario's own notes.
      const documents = app.groundingText.trim()
        ? [
            {
              id: 'pasted',
              kind: 'job_description' as const,
              title: 'Pasted document',
              text: app.groundingText,
              updatedAt: Date.now(),
            },
          ]
        : [];
      let retriever: Retriever | undefined;
      const corpus = buildCorpus(scenario, documents);
      if (corpus.length > 0) {
        const lexical = new LexicalRetriever();
        await lexical.index(corpus);
        retriever = lexical;
      }

      const session = new InterviewSession({
        preset,
        scenario,
        learner,
        ...(retriever ? { retriever } : {}),
        // On-device models cannot follow the full prompt; see PromptStyle.
        promptStyle: selected.vendor === 'on-device' ? 'compact' : 'full',
        stages: {
          recognizer: pipeline.recognizer,
          model: languageModel,
          synthesizer: pipeline.synthesizer,
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
