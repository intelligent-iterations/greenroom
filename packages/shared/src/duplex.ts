/**
 * Duplex voice interfaces, re-exported from `greenroom-realtime`.
 *
 * These used to be defined here. They now live in a standalone published
 * package because the interface is useful to anyone integrating a realtime
 * voice API, not only to this repository — and because an interface that ships
 * on its own is one that has to be honest about what it does and does not
 * verify.
 *
 * Re-exported rather than moved so that `@greenroom/shared` keeps the same
 * public surface, and so there is exactly one definition. Two copies of a
 * protocol interface in one workspace is the drift failure `checks.ts` names.
 *
 * A native realtime API collapses STT + LLM + TTS into one bidirectional audio
 * stream. It does not fit the cascaded stage interfaces in pipeline.ts, and no
 * amount of adapting makes it — docs/adr/0002-cascaded-vs-realtime.md says so
 * and is still right. This is a second, parallel seam, not an extension of the
 * first.
 *
 * STATUS: `greenroom-realtime` now ships a real Moshi client, protocol-verified
 * against the reference implementation and tested against a scripted socket —
 * but no byte from it has reached a live server, and nothing in this app is
 * wired to it yet. See the package README for exactly what is and is not
 * proven.
 */
export type {
  DuplexAudioChunk,
  DuplexLoadProgress,
  DuplexCapabilities,
  DuplexEvent,
  DuplexSessionOptions,
  DuplexVoiceStage,
} from 'greenroom-realtime';
