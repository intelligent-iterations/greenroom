# ADR 0002: Cascaded pipeline rather than a native realtime API

**Status:** accepted
**Date:** 2026-09-05

## Context

Two architectures are available for a spoken conversational agent.

**Cascaded:** VAD → STT → LLM → TTS, four replaceable stages, orchestrated
locally.

**Native realtime:** a single duplex speech-to-speech stream (Gemini Live, Azure
Realtime, OpenAI Realtime) or a managed voice platform (ElevenLabs Agents,
LiveKit, Vapi).

Realtime APIs are better at the things a cascade is worst at: they are faster to
first audio, they handle interruption natively, and they preserve prosody and
emotion that a transcript throws away. If latency and naturalness were the only
criteria this would not be a close call.

## Decision

Cascaded, on-device, with the stages behind narrow interfaces.

## Rationale

**No realtime voice API runs on-device.** Every one of them is a hosted service
holding an open socket to a vendor for the duration of the conversation.
Choosing one means giving up ADR 0001 entirely — not degrading it, ending it.
That single fact decides this.

Secondary reasons that would not have been sufficient alone:

- **The transcript is a product requirement, not a by-product.** Feedback quotes
  what the learner said, and mastery scoring reads the transcript as evidence. A
  cascade produces it for free; realtime pipelines produce it as a lower-quality
  side channel, when they produce it at all.
- **Stage-level swappability is the portability story.** Whisper can be replaced
  with a vendor STT, the on-device model with Azure, Kokoro with ElevenLabs,
  independently and behind one interface each. A realtime API is all-or-nothing
  per vendor.
- **Per-stage latency attribution.** When a turn is slow, a cascade says which
  stage was slow. A duplex stream says the turn was slow.
- **Testability.** The concurrency that actually breaks — barge-in, queue
  ordering, abort propagation — is tested against scripted fakes. A realtime
  socket is far harder to test at that level.

## Consequences

- Higher first-audio latency than realtime, structurally. Mitigated by
  sentence-level handoff: TTS starts on the first complete sentence rather than
  the full response. This is the single largest win available in a cascade and
  it is why `splitSpeakableChunks` exists and is tested.
- Barge-in must be implemented by hand, including the self-interruption problem
  that an open mic during playback creates. Realtime APIs give this away free.
- Prosody in the learner's speech is lost at the STT boundary. Hesitation and
  uncertainty are pedagogically interesting signals and this architecture cannot
  see them. Accepted; noted as a real limitation.

## Revisit when

An on-device duplex speech model becomes practical in a browser, or the product
requirements change such that hosted inference is acceptable. At that point the
stage interfaces in `pipeline.ts` do **not** help — realtime collapses all three
into one — and the orchestrator would be replaced rather than reconfigured. That
is understood and accepted; pretending the abstraction covers realtime would be
a worse lie than not having it.
