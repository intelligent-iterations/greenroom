import { useCallback, useEffect, useRef, useState } from 'react';
import { AutoTokenizer } from '@huggingface/transformers';
import {
  LFM_MODELS,
  LfmAudioStage,
  summarise,
  type FolderSurvey,
  type LfmModelSpec,
} from 'greenroom-realtime/lfm2';
import { FolderAssetSource, surveyFolder, type LoadStep } from '../voice/lfm-assets.js';
import { createSession, requireWebGpu, tensorFactory } from '../voice/lfm-runtime.js';
import {
  chooseModelFolder,
  grantModelFolder,
  restoreModelFolder,
  supportsModelFolder,
} from '../voice/model-store.js';
import { logEvent } from '../voice/diagnostics.js';

/**
 * Setting up a two-gigabyte model, as a sequence rather than a button.
 *
 * The first version was one button that either worked or sat there. It could
 * start a 2GB download with nowhere to put it, it never remembered the folder
 * between sessions — the thing the folder exists for — and while loading it
 * showed nothing, so a working download and a hung one looked identical.
 *
 * This is the same work expressed as four gates, each of which can be checked,
 * reported, and repaired on its own: can this machine run it, where do the
 * files go, are they there, and then talk. Nothing proceeds past a gate it has
 * not satisfied.
 */

export type SetupGate = 'device' | 'location' | 'files' | 'ready';

export type RealtimePhase =
  | 'setup'
  | 'loading'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface GateState {
  device: { checked: boolean; ok: boolean; detail?: string };
  location: {
    folder?: FileSystemDirectoryHandle;
    name?: string;
    needsPermission: boolean;
    supported: boolean;
  };
  files: { survey?: FolderSurvey; summary?: string };
}

export function useRealtime() {
  const [phase, setPhase] = useState<RealtimePhase>('setup');
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<LfmModelSpec>(LFM_MODELS[0] as LfmModelSpec);
  const [steps, setSteps] = useState<LoadStep[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [expected, setExpected] = useState(0);
  const [transcript, setTranscript] = useState<{ role: 'you' | 'agent'; text: string }[]>([]);
  const [gates, setGates] = useState<GateState>({
    device: { checked: false, ok: false },
    location: { needsPermission: false, supported: supportsModelFolder() },
    files: {},
  });

  const stageRef = useRef<LfmAudioStage | undefined>(undefined);
  const audioRef = useRef<AudioContext | undefined>(undefined);
  const micRef = useRef<MediaStream | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const playheadRef = useRef(0);
  const bytesPerFile = useRef(new Map<string, number>());

  /** Check the device once, unprompted: it gates everything and costs nothing. */
  useEffect(() => {
    void requireWebGpu().then((result) => {
      setGates((g) => ({
        ...g,
        device: {
          checked: true,
          ok: result.ok,
          ...(result.ok ? {} : { detail: result.reason }),
        },
      }));
    });
  }, []);

  /**
   * Offer back the folder from last time.
   *
   * This is the continuity the whole folder mechanism exists for, and its
   * absence was the defect: without it every session started by asking where to
   * put two gigabytes that were already on disk.
   */
  useEffect(() => {
    if (!supportsModelFolder()) return;
    void restoreModelFolder().then(async (found) => {
      if (!found) return;
      setGates((g) => ({
        ...g,
        location: {
          folder: found.handle,
          name: found.handle.name,
          needsPermission: found.needsPermission,
          supported: true,
        },
      }));
      // A lapsed permission cannot be re-granted without a gesture, so the
      // survey waits rather than failing every read and reporting "missing".
      if (!found.needsPermission) await refreshSurvey(found.handle);
    });
  }, []);

  const refreshSurvey = useCallback(
    async (handle: FileSystemDirectoryHandle, suffix = model.suffix) => {
      const survey = await surveyFolder(handle, suffix);
      setGates((g) => ({ ...g, files: { survey, summary: summarise(survey) } }));
      return survey;
    },
    [model.suffix],
  );

  const pickFolder = useCallback(async () => {
    const handle = await chooseModelFolder();
    if (!handle) return;
    setGates((g) => ({
      ...g,
      location: { folder: handle, name: handle.name, needsPermission: false, supported: true },
    }));
    await refreshSurvey(handle);
  }, [refreshSurvey]);

  const reconnect = useCallback(async () => {
    const handle = gates.location.folder;
    if (!handle) return;
    const granted = await grantModelFolder(handle);
    setGates((g) => ({ ...g, location: { ...g.location, needsPermission: !granted } }));
    if (granted) await refreshSurvey(handle);
  }, [gates.location.folder, refreshSurvey]);

  /** Which gate is still blocking, so a screen can show one thing at a time. */
  const gate: SetupGate = !gates.device.ok
    ? 'device'
    : !gates.location.folder || gates.location.needsPermission
      ? 'location'
      : !gates.files.survey
        ? 'files'
        : 'ready';

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase('setup');
  }, []);

  const start = useCallback(async () => {
    const folder = gates.location.folder;
    // The trap the first version had: with no folder this downloaded two
    // gigabytes into memory and lost every byte on reload.
    if (gates.location.supported && !folder) {
      setError('Choose a folder first, or the download will not survive a reload.');
      return;
    }
    if (!gates.device.ok) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('loading');
    setError(undefined);
    setSteps([]);
    bytesPerFile.current.clear();

    try {
      const assets = new FolderAssetSource({
        repo: model.repo,
        suffix: model.suffix,
        ...(folder ? { folder } : {}),
        createSession,
        signal: controller.signal,
      });
      setExpected(assets.totalBytes);

      assets.onStep((step) => setSteps((s) => [...s.slice(-40), step]));
      assets.onProgress((p) => {
        bytesPerFile.current.set(p.file, p.loaded);
        let total = 0;
        for (const value of bytesPerFile.current.values()) total += value;
        setLoaded(total);
      });

      setSteps((s) => [...s, { kind: 'checking', file: 'tokenizer' }]);
      const tokenizer = await AutoTokenizer.from_pretrained(model.repo);

      const stage = new LfmAudioStage({
        assets,
        tensor: tensorFactory,
        suffix: model.suffix,
        encode: (text) => Array.from(tokenizer.encode(text) as number[]),
        decode: (tokens) => tokenizer.decode(tokens, { skip_special_tokens: true }) as string,
      });

      await stage.load();
      stageRef.current = stage;
      await stage.open();

      if (folder) await refreshSurvey(folder);
      void consume(stage);
      await startMic(stage);
      setPhase('listening');
    } catch (caught) {
      if (controller.signal.aborted) {
        setPhase('setup');
        return;
      }
      logEvent('realtime.load.failed', { error: String(caught) });
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('error');
    }
  }, [gates, model, refreshSurvey]);

  /**
   * Play chunks back to back on the AudioContext clock.
   *
   * Scheduling each against `currentTime` compounds the gap between chunks into
   * audible stutter; carrying a playhead forward keeps them continuous.
   */
  const play = useCallback((samples: Float32Array, sampleRate: number) => {
    const context = (audioRef.current ??= new AudioContext());
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = Math.max(context.currentTime, playheadRef.current);
    source.start(at);
    playheadRef.current = at + buffer.duration;
  }, []);

  const consume = useCallback(
    async (stage: LfmAudioStage) => {
      for await (const event of stage.events()) {
        if (event.type === 'assistant_audio') {
          setPhase('speaking');
          play(event.chunk.samples, event.chunk.sampleRate);
        } else if (event.type === 'assistant_transcript') {
          setTranscript((t) => {
            const last = t[t.length - 1];
            if (last?.role === 'agent') {
              return [...t.slice(0, -1), { role: 'agent', text: last.text + event.text }];
            }
            return [...t, { role: 'agent', text: event.text }];
          });
        } else if (event.type === 'assistant_turn_complete') {
          setPhase('listening');
        } else if (event.type === 'error') {
          setError(event.error.message);
          setPhase('error');
        }
      }
    },
    [play],
  );

  /**
   * Capture at 16kHz, which is what the mel frontend expects.
   *
   * The context is opened at that rate rather than resampled afterwards:
   * browsers default to 48kHz, and a frontend fed the wrong rate produces a
   * spectrogram that is wrong in a way nothing reports.
   */
  const startMic = useCallback(async (stage: LfmAudioStage) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    micRef.current = stream;

    const context = new AudioContext({ sampleRate: 16_000 });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);

    let silenceFrames = 0;
    let speaking = false;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      stage.send({ samples: new Float32Array(input), sampleRate: 16_000 });

      let energy = 0;
      for (const s of input) energy += s * s;
      if (Math.sqrt(energy / input.length) > 0.015) {
        speaking = true;
        silenceFrames = 0;
      } else if (speaking) {
        silenceFrames += 1;
        // 4096 samples at 16kHz is 256ms; three of them is ~768ms of silence.
        if (silenceFrames >= 3) {
          speaking = false;
          silenceFrames = 0;
          setPhase('thinking');
          void stage.respond();
        }
      }
    };

    source.connect(processor);
    processor.connect(context.destination);
  }, []);

  const stop = useCallback(async () => {
    await stageRef.current?.close();
    micRef.current?.getTracks().forEach((t) => t.stop());
    setPhase('setup');
  }, []);

  return {
    phase,
    gate,
    gates,
    error,
    model,
    setModel,
    models: LFM_MODELS,
    steps,
    loaded,
    expected,
    transcript,
    pickFolder,
    reconnect,
    start,
    cancel,
    stop,
  };
}
