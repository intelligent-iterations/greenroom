/**
 * Exactly what a model is made of, and how big each piece should be.
 *
 * Two problems this solves, both of which the first version had.
 *
 * Progress was meaningless until it was nearly over: the total was summed from
 * whichever files had already started, so the denominator grew as the numerator
 * did and the bar lurched. With a manifest the total is known before the first
 * byte arrives, so "2.1 of 2.3 GB" is true from the beginning.
 *
 * And a file on disk was trusted because it existed. A truncated download — a
 * closed tab, a full disk, a process the OS killed — left a file that the next
 * session read as complete and handed to ONNX Runtime, which fails somewhere
 * far away from the cause. A known size turns that into a cheap check.
 *
 * Sizes are `Content-Length` from the Hugging Face CDN, recorded on
 * 2026-09-12. They are facts about published artefacts, so they do not drift;
 * if one ever mismatches, the model was republished and that is worth knowing
 * loudly rather than discovering through a corrupt graph.
 */

export interface ManifestEntry {
  file: string;
  bytes: number;
  /** Everything except embed_tokens.bin is part of an ONNX session. */
  role: 'graph' | 'weights' | 'table';
}

export const LFM_Q4_MANIFEST: ManifestEntry[] = [
  { file: 'audio_encoder_q4.onnx', bytes: 477_419, role: 'graph' },
  { file: 'audio_encoder_q4.onnx_data', bytes: 139_110_400, role: 'weights' },
  { file: 'decoder_q4.onnx', bytes: 169_181, role: 'graph' },
  { file: 'decoder_q4.onnx_data', bytes: 1_217_650_688, role: 'weights' },
  { file: 'vocoder_depthformer_q4.onnx', bytes: 54_511, role: 'graph' },
  { file: 'vocoder_depthformer_q4.onnx_data', bytes: 187_166_720, role: 'weights' },
  { file: 'audio_detokenizer_q4.onnx', bytes: 74_691, role: 'graph' },
  { file: 'audio_detokenizer_q4.onnx_data', bytes: 56_481_416, role: 'weights' },
  { file: 'audio_embedding_q4.onnx', bytes: 358, role: 'graph' },
  { file: 'audio_embedding_q4.onnx_data', bytes: 134_283_264, role: 'weights' },
  { file: 'embed_tokens.bin', bytes: 536_870_912, role: 'table' },
];

export function manifestFor(suffix: string): ManifestEntry[] {
  if (suffix === '_q4') return LFM_Q4_MANIFEST;
  // Other precisions exist but their sizes have not been recorded, and a
  // guessed size is worse than none: it would reject good files as corrupt.
  return [];
}

export function totalBytes(manifest: readonly ManifestEntry[]): number {
  return manifest.reduce((sum, entry) => sum + entry.bytes, 0);
}

export function expectedBytes(manifest: readonly ManifestEntry[], file: string): number | undefined {
  return manifest.find((entry) => entry.file === file)?.bytes;
}

/**
 * What a folder holds, judged against the manifest rather than by existence.
 *
 * `corrupt` is deliberately separate from `missing`. They need different words
 * in front of a person — one means "this will download", the other means
 * "something here is wrong and will be replaced" — and lumping them together
 * is how a re-download looks like the app forgetting what it already had.
 */
export interface FolderSurvey {
  complete: ManifestEntry[];
  missing: ManifestEntry[];
  corrupt: { entry: ManifestEntry; actualBytes: number }[];
  presentBytes: number;
  totalBytes: number;
}

export function summarise(survey: FolderSurvey): string {
  if (survey.missing.length === 0 && survey.corrupt.length === 0) {
    return 'Every file is here. Nothing to download.';
  }
  const parts: string[] = [];
  if (survey.complete.length > 0) {
    parts.push(`${survey.complete.length} of ${survey.complete.length + survey.missing.length + survey.corrupt.length} files ready`);
  }
  if (survey.corrupt.length > 0) {
    parts.push(`${survey.corrupt.length} incomplete and will be replaced`);
  }
  const remaining =
    survey.totalBytes - survey.presentBytes > 0 ? survey.totalBytes - survey.presentBytes : 0;
  parts.push(`${(remaining / 1_073_741_824).toFixed(2)} GB to download`);
  return parts.join(' · ');
}
