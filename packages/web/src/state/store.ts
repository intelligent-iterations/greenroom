import type { LearnerState, LoadProgress, Turn, TurnTimings } from '@greenroom/shared';
import { create } from 'zustand';
import type { SessionState } from '../voice/session.js';

/**
 * UI state for a live session.
 *
 * The orchestrator is an event emitter, not a React construct, on purpose — the
 * voice loop must not be coupled to a render cycle. This store is the single
 * adapter between the two, so every component reads one source and the pipeline
 * never reaches into React.
 */
export type Phase = 'setup' | 'live' | 'debrief' | 'evals';

export interface LatencySample extends TurnTimings {
  turnIndex: number;
}

interface AppStore {
  phase: Phase;
  scenarioId: string;
  learner?: LearnerState;
  sessionState: SessionState;
  turns: Turn[];
  /** Partial interviewer text for the live caption. */
  liveText: string;
  progress?: LoadProgress;
  latency: LatencySample[];
  error?: string;
  /** Set when the learner opts into cloud inference for this session. */
  allowCloud: boolean;
  /** Chosen on-device model id, or undefined to let the router decide. */
  modelId?: string;
  /** A Hugging Face repo the user typed in, outside the built-in catalogue. */
  customModelRepo?: string;
  /** Files from a folder the user chose, consulted before the network. */
  localModelFiles?: [string, File][];
  localModelLabel?: string;
  /** Which conversational partner to run. */
  presetId: string;
  /** System prompt for the 'custom' preset. */
  customPrompt: string;

  setPhase: (phase: Phase) => void;
  setScenario: (id: string) => void;
  setLearner: (learner: LearnerState) => void;
  setAllowCloud: (allow: boolean) => void;
  setModelId: (id: string | undefined) => void;
  setCustomModelRepo: (repo: string | undefined) => void;
  setLocalModel: (files: [string, File][] | undefined, label?: string) => void;
  setPresetId: (id: string) => void;
  setCustomPrompt: (prompt: string) => void;
  setSessionState: (state: SessionState) => void;
  setProgress: (progress: LoadProgress) => void;
  addTurn: (turn: Turn) => void;
  setLiveText: (text: string) => void;
  addLatency: (timings: TurnTimings) => void;
  setError: (message?: string) => void;
  resetSession: () => void;
}

export const useAppStore = create<AppStore>((set) => ({
  phase: 'setup',
  scenarioId: 'backend-mid-en',
  sessionState: 'idle',
  turns: [],
  liveText: '',
  latency: [],
  allowCloud: false,
  presetId: 'chat',
  customPrompt: '',

  setPhase: (phase) => set({ phase }),
  setScenario: (scenarioId) => set({ scenarioId }),
  setLearner: (learner) => set({ learner }),
  setAllowCloud: (allowCloud) => set({ allowCloud }),
  setModelId: (modelId) => set({ modelId }),
  setCustomModelRepo: (customModelRepo) => set({ customModelRepo }),
  setLocalModel: (localModelFiles, localModelLabel) => set({ localModelFiles, localModelLabel }),
  setPresetId: (presetId) => set({ presetId }),
  setCustomPrompt: (customPrompt) => set({ customPrompt }),
  setSessionState: (sessionState) => set({ sessionState }),
  setProgress: (progress) => set({ progress }),
  // The live caption is replaced by the committed turn, so it clears here
  // rather than in the component — otherwise the last partial flashes again on
  // the next render before the new turn arrives.
  addTurn: (turn) => set((s) => ({ turns: [...s.turns, turn], liveText: '' })),
  setLiveText: (liveText) => set({ liveText }),
  addLatency: (timings) =>
    set((s) => ({ latency: [...s.latency, { ...timings, turnIndex: s.latency.length }] })),
  setError: (error) => set({ error }),
  resetSession: () =>
    set({
      sessionState: 'idle',
      turns: [],
      liveText: '',
      latency: [],
      progress: undefined,
      error: undefined,
    }),
}));

/** Median of a numeric sample. Used for the latency HUD and session records. */
export function median(values: number[]): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/** Nth percentile by nearest-rank. Small samples make interpolation pointless. */
export function percentile(values: number[], p: number): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}
