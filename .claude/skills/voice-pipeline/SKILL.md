---
name: voice-pipeline
description: Build, measure or debug a cascaded speech pipeline (VAD to STT to LLM to TTS), or decide between a cascade and a native realtime duplex API. Use when a voice agent feels slow or laggy, interruption/barge-in misbehaves, choosing between OpenAI/Gemini/Azure Realtime and a stitched pipeline, measuring voice latency, or when spoken replies arrive late or read model output aloud that they should not.
---

# Building and measuring a cascaded voice loop

A cascade — VAD → STT → LLM → TTS — is easy to build badly. The difference
between a walkie-talkie and a conversation is three things, and none of them is
the model.

Reference: `packages/web/src/voice/session.ts` and `packages/shared/src/pipeline.ts`.

## Measure from when the person stopped talking

Anchor every latency on the moment the user **stopped speaking**, not mic-open.
Measuring from mic-open makes a slow talker look like a slow system, and the
number a user actually feels is the silence after they finish.

Attribute per stage. When a turn is slow a cascade can say *which* stage was
slow; a duplex stream can only say the turn was slow.

## Sentence-level handoff

Waiting for a full response before speaking adds a second or more of dead air.
Split the token stream at sentence boundaries and start synthesising the first
sentence while the model is still writing the second.

Two details that matter:

- Require whitespace after the terminator, or `3.5` and `Ph.D.` split.
- **For the first chunk of a turn only, a comma will do.** Starting a sentence
  earlier is worth more than the prosody it costs. Once audio is playing,
  sentence boundaries resume.

## Barge-in, and the self-interruption livelock

Being interruptible is most of what makes a voice agent feel like a conversation
rather than a phone tree. Speech detected during playback must abort the model
stream and stop audio in the same tick.

Then the problem it creates: **the microphone is open while the agent talks, so
it hears itself and interrupts itself, and the session livelocks on turn one.**
Two fixes together —

1. open the audio stream with echo cancellation *in your own capture code*, not
   relying on the VAD library's defaults; and
2. a short guard window after playback starts during which detected speech is
   ignored, while the browser's AEC converges.

Make the guard a named constant, and if you have two orchestrators, **import it
rather than copying it**. Two guard windows that drift is how the one nobody
looks at becomes the one in production.

## Never let deliberation reach the speaker

A leaked `<think>` block is not degraded output — it is the synthesiser reading
the model's private reasoning aloud in the agent's voice. Strip it with a
**stateful** filter: tags arrive split across deltas (`<thi` in one, `nk>` in the
next) and a stateless regex emits the halves.

## Reasoning models share their token budget

A reasoning model counts deliberation and answer against the same `max_tokens`.
Ask for 200 and it can spend all 200 thinking and return an empty string with a
healthy `finish_reason`. That scores as a catastrophic quality failure and sends
someone to bisect a prompt that was fine.

- Grant reasoning headroom **on top of** the caller's budget, not out of it.
- `max_tokens` is a ceiling, not a spend — generosity is free when unused.
- Effort hints are hints. One model here spent 0 reasoning tokens on most turns
  and over two thousand on the same prompt, so a tight budget fails
  *intermittently*, which reads as a flaky model rather than a bad request.
- On an empty result, **fail by name** rather than returning "".

## Verify artifacts before running

"The model is listed" is not "the model loads". A unit test here asserted a
model id existed in a registry, passed, and the model still could not load
because the weights were never published — surfacing as an opaque cache error
tens of seconds into a session. **Verifying the wrong thing was worse than not
verifying, because it bought confidence.**

Declare the stages as data, have the adapters and the checker read the same
declaration, and HEAD-check every resolved URL before anyone downloads a
gigabyte.

## Cascade or native realtime?

Realtime duplex APIs are better at what a cascade is worst at: faster to first
audio, native interruption, and they preserve prosody a transcript throws away.
Choose a cascade when:

- inference must stay on-device — no duplex API runs locally, so choosing one
  ends that premise rather than degrading it
- **the transcript is a product requirement**, not a by-product. A cascade
  produces it for free; duplex produces it as a lower-quality side channel, when
  it produces it at all
- you need per-stage latency attribution, or stage-by-stage vendor swapping
- the concurrency needs testing against scripted fakes

And know the cost before you switch: **a duplex session sets its system prompt
once, at socket open, and cannot recompile per turn.** Anything that steers per
turn — coverage tracking, retrieved grounding, adaptive difficulty — does not
survive the move.

If you build both, build the duplex path as a **parallel orchestrator**, not an
extension of the cascade's stage interfaces. Realtime collapses three stages
into one; pretending one abstraction covers both is a worse lie than having two.
