import { useCallback, useRef, useState } from 'react';
import { AutoTokenizer } from '@huggingface/transformers';
import { LFM_MODELS, LfmAudioStage, type LfmModelSpec } from 'greenroom-realtime/lfm2';
import { FolderAssetSource, surveyFolder } from '../voice/lfm-assets.js';
import { createSession, requireWebGpu, tensorFactory } from '../voice/lfm-runtime.js';
import { logEvent } from '../voice/diagnostics.js';

/**
 * The in-browser speech-to-speech session.
 *
 * Kept apart from `useSession`, which orchestrates the cascade. The two are
 * different architectures — one model versus three, one latency versus three —
 * and folding them into one hook would mean a pile of branches inside every
 * method. ADR 0002 makes the same argument about the interfaces; this is that
 * argument applied to the React layer.
 */

export type RealtimePhase =
  | 'idle'
  | 'checking'
  | 'blocked'
  | 'needs-folder'
  | 'ready-to-load'
  | 'loading'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface RealtimeFile {
  file: string;
  loaded: number;
  total?: number;
  cached?: boolean;
}

export function useRealtime() {
  const [phase, setPhase] = useState<RealtimePhase>('idle');
  const [message, setMessage] = useState<string>();
  const [model, setModel] = useState<LfmModelSpec>(LFM_MODELS[0] as LfmModelSpec);
  const [folder, setFolder] = useState<FileSystemDirectoryHandle>();
  const [survey, setSurvey] = useState<{ present: number; missing: number; bytes: number }>();
  const [files, setFiles] = useState<Map<string, RealtimeFile>>(new Map());
  const [transcript, setTranscript] = useState<{ role: 'you' | 'agent'; text: string }[]>([]);

  const stageRef = useRef<LfmAudioStage | undefined>(undefined);
  const audioRef = useRef<AudioContext | undefined>(undefined);
  const micRef = useRef<MediaStream | undefined>(undefined);
  const playheadRef = useRef(0);

  /** Ask for the folder, and report what is already in it. */
  const chooseFolder = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      setFolder(handle);
      const found = await surveyFolder(handle, model.suffix);
      setSurvey({ present: found.present.length, missing: found.missing.length, bytes: found.bytes });
      setPhase(found.missing.length === 0 ? 'ready-to-load' : 'ready-to-load');
      setMessage(
        found.missing.length === 0
          ? `All ${found.present.length} files are already here. Nothing to download.`
          : `${found.present.length} of ${found.present.length + found.missing.length} files present; the rest will download.`,
      );
    },
    [model],
  );

  const load = useCallback(async () => {
    setPhase('checking');
    const gpu = await requireWebGpu();
    if (!gpu.ok) {
      setPhase('blocked');
      setMessage(gpu.reason);
      return;
    }

    setPhase('loading');
    setMessage(undefined);
    try {
      const assets = new FolderAssetSource({
        repo: model.repo,
        ...(folder ? { folder } : {}),
        createSession,
      });
      assets.onProgress((p) => {
        setFiles((previous) => {
          const next = new Map(previous);
          next.set(p.file, p);
          return next;
        });
      });

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

      void consume(stage);
      await startMic(stage);
      setPhase('listening');
    } catch (error) {
      logEvent('realtime.load.failed', { error: String(error) });
      setPhase('error');
      setMessage(String(error));
    }
  }, [folder, model]);

  /**
   * Play chunks back to back on the AudioContext clock.
   *
   * Scheduling against `currentTime` each time would compound the gap between
   * chunks into audible stutter; carrying a playhead forward is what makes
   * 320ms batches sound continuous.
   */
  const play = useCallback((samples: Float32Array, sampleRate: number) => {
    const context = (audioRef.current ??= new AudioContext());
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    // Copied into a fresh view: copyToChannel rejects a Float32Array backed by
    // a SharedArrayBuffer, which is what cross-origin isolation gives us.
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
          setPhase('error');
          setMessage(event.error.message);
        }
      }
    },
    [play],
  );

  /**
   * Capture at 16kHz, which is what the mel frontend expects.
   *
   * The AudioContext is created at that rate rather than resampled afterwards:
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

      // A simple energy gate rather than Silero: this path has no VAD of its
      // own yet, and an obvious threshold that can be tuned beats a dependency
      // that hides the decision.
      let energy = 0;
      for (const s of input) energy += s * s;
      const loud = Math.sqrt(energy / input.length) > 0.015;

      if (loud) {
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
    setPhase('idle');
  }, []);

  return {
    phase,
    message,
    model,
    setModel,
    folder,
    chooseFolder,
    survey,
    files: [...files.values()],
    transcript,
    load,
    stop,
    models: LFM_MODELS,
  };
}
