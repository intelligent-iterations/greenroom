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

/**
 * Endpointing thresholds, named because both are tuning decisions.
 *
 * RMS rather than a VAD model: the cascade's Silero VAD is a second ONNX
 * session, and this path already holds five. Energy is cruder — it will not
 * tell speech from a slammed door — but it costs nothing, and the model's own
 * recogniser is what decides whether the audio was words.
 */
const SPEECH_RMS = 0.015;
/** Frames of silence (256ms each) that end a turn — about 768ms. */
const SILENCE_FRAMES = 3;

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
  /** The capture graph, kept so it can actually be torn down. */
  const captureRef = useRef<{ context: AudioContext; processor: ScriptProcessorNode } | undefined>(
    undefined,
  );
  const startingRef = useRef(false);
  /** Sources scheduled but not yet finished, so barge-in can cut them off. */
  const playingRef = useRef<AudioBufferSourceNode[]>([]);
  /** Whether the model is mid-reply, for barge-in. A ref: the mic callback
   *  runs every 256ms and must not read stale state from a closure. */
  const speakingRef = useRef(false);
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

  /**
   * Release everything, in an order that is safe to repeat.
   *
   * Each of these leaked before: the stage kept five GPU sessions, the
   * ScriptProcessor kept feeding audio into a stage nobody was reading, and
   * the AudioContext kept the microphone light on. Stopping the tracks alone
   * — which is all the old stop() did — left the first two running.
   */
  const teardown = useCallback(async () => {
    const capture = captureRef.current;
    captureRef.current = undefined;
    if (capture) {
      capture.processor.onaudioprocess = null;
      capture.processor.disconnect();
      await capture.context.close().catch(() => {});
    }

    micRef.current?.getTracks().forEach((t) => t.stop());
    micRef.current = undefined;

    const stage = stageRef.current;
    stageRef.current = undefined;
    if (stage) {
      // close() waits for a turn in flight; unload() then frees the sessions.
      await stage.close().catch(() => {});
      await stage.unload().catch(() => {});
    }

    if (audioRef.current) {
      await audioRef.current.close().catch(() => {});
      audioRef.current = undefined;
    }
    playheadRef.current = 0;
    speakingRef.current = false;
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    void teardown();
    setPhase('setup');
  }, [teardown]);

  const start = useCallback(async () => {
    const folder = gates.location.folder;
    // The trap the first version had: with no folder this downloaded two
    // gigabytes into memory and lost every byte on reload.
    if (gates.location.supported && !folder) {
      setError('Choose a folder first, or the download will not survive a reload.');
      return;
    }
    if (!gates.device.ok) return;
    // Re-entry guard. Each attempt builds five GPU sessions and a microphone
    // graph; a second one started while the first is still loading leaves both
    // alive, and two copies of a 2GB model do not fit. The error state puts a
    // button back on screen, so this is reachable by anyone clicking twice.
    if (startingRef.current) return;
    startingRef.current = true;

    // Whatever came before is finished with. Sessions hold GPU buffers that
    // are not reclaimed by dropping the reference.
    await teardown();

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
      // A failed attempt must not keep its sessions: the next try needs the
      // memory, and this is exactly how one failure became an unrecoverable
      // tab.
      await teardown();
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('error');
    } finally {
      startingRef.current = false;
    }
  }, [gates, model, refreshSurvey, teardown]);

  /**
   * Play chunks back to back on the AudioContext clock.
   *
   * Scheduling each against `currentTime` compounds the gap between chunks into
   * audible stutter; carrying a playhead forward keeps them continuous.
   */
  /**
   * Silence whatever is already scheduled.
   *
   * Chunks are queued ahead on the AudioContext clock, so aborting generation
   * alone leaves up to a few hundred milliseconds still to play. Interrupting
   * a voice that keeps talking is not interrupting it.
   */
  const stopPlayback = useCallback(() => {
    for (const source of playingRef.current) {
      try {
        source.stop();
      } catch {
        // Already finished; nothing to stop.
      }
    }
    playingRef.current = [];
    playheadRef.current = 0;
  }, []);

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
    playingRef.current.push(source);
    source.onended = () => {
      playingRef.current = playingRef.current.filter((s) => s !== source);
    };
  }, []);

  const consume = useCallback(
    async (stage: LfmAudioStage) => {
      for await (const event of stage.events()) {
        if (event.type === 'assistant_audio') {
          speakingRef.current = true;
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
          speakingRef.current = false;
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
    captureRef.current = { context, processor };

    let silenceFrames = 0;
    let speaking = false;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      stage.send({ samples: new Float32Array(input), sampleRate: 16_000 });

      let energy = 0;
      for (const s of input) energy += s * s;
      const loud = Math.sqrt(energy / input.length) > SPEECH_RMS;

      if (loud) {
        // Barge-in. The model has no notion of being interrupted — its
        // capabilities say nativeBargeIn is false — so it is this detector's
        // job, and until now nobody was doing it: the reply played to the end
        // however much you talked over it.
        if (!speaking && speakingRef.current) {
          speakingRef.current = false;
          stage.interrupt();
          stopPlayback();
          setPhase('listening');
        }
        speaking = true;
        silenceFrames = 0;
      } else if (speaking) {
        silenceFrames += 1;
        // 4096 samples at 16kHz is 256ms; three of them is ~768ms of silence.
        if (silenceFrames >= SILENCE_FRAMES) {
          speaking = false;
          silenceFrames = 0;
          // A turn already generating is left alone. respond() would abort and
          // restart it, so a pause mid-sentence would throw away the reply
          // being produced for the sentence before it.
          if (!stage.busy) {
            setPhase('thinking');
            void stage.respond();
          }
        }
      }
    };

    source.connect(processor);
    processor.connect(context.destination);
  }, [stopPlayback]);

  const stop = useCallback(async () => {
    abortRef.current?.abort();
    await teardown();
    setPhase('setup');
  }, [teardown]);

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
