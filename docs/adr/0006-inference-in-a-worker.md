# ADR 0006: All inference runs in a Web Worker

**Status:** accepted
**Date:** 2026-09-05

## Context

The pipeline originally ran speech recognition, generation and synthesis on the
main thread. It worked, in the sense that a session produced spoken replies.

Then we measured it, and Chrome reported the renderer as unresponsive. Kokoro
synthesis and ONNX Runtime's JS-side work block the main thread for seconds at a
time.

## Why this is not a performance nit

While the main thread is blocked, the voice-activity detector cannot deliver a
callback. `onSpeechStart` is how the orchestrator learns that the learner has
started talking, and it is the only mechanism by which a turn gets interrupted.

So a blocked main thread does not make barge-in slow. **It makes barge-in
impossible.** The learner can talk over the interviewer all they like; nothing
is listening until synthesis finishes, by which point there is nothing left to
interrupt.

Barge-in is the feature that makes a voice agent feel like a conversation rather
than a phone tree. It cannot be built on top of a blocked main thread, and no
amount of tuning the guard window or the VAD thresholds changes that.

## Decision

Recognition, generation and synthesis move into a single dedicated worker
(`inference.worker.ts`). The main thread keeps only what must live there: the
microphone, the VAD, and audio playback. All three are cheap.

`InferencePipeline` presents the same `SpeechRecognizer`, `LanguageModel` and
`SpeechSynthesizer` interfaces over `postMessage`, so the orchestrator did not
change at all. That is the return on having defined those interfaces up front:
a change to where computation happens was invisible to the code that sequences
it, and the pipeline concurrency tests kept passing throughout.

Synthesised audio comes back as raw samples and is transferred rather than
copied — a worker has no output device, and these buffers arrive on every
sentence.

## Consequences

- Measured with the worker in place, the main thread reports **0ms of lag while
  inference runs**, against a renderer that previously stopped answering at all.
  That is the precondition for barge-in, tested directly.
- One worker rather than three: the models share a GPU device and an ONNX
  runtime, and interleaving three workers on one GPU would add contention for no
  benefit.
- The attention cache lives in the worker, next to the model that owns it.
- Interruption is now a message (`interrupt`) that reaches
  `InterruptableStoppingCriteria` and actually halts decoding, instead of the
  main thread merely ceasing to read tokens while the GPU keeps working.

## A second bug this exposed

Moving to a worker surfaced a deadlock that had been present all along:
`AudioContext.resume()` does not reject when there has been no user gesture — it
never settles. Awaiting it unguarded means `speak()` never resolves, the speech
queue never drains, and the session hangs silently with no error anywhere.

Two fixes, because either alone is fragile:

- `primeAudio()` is called from the click that starts a session, which is the
  user gesture browsers require. Without it the interviewer is simply inaudible,
  and nothing is logged to say why.
- The resume is raced against a timeout, and playback carries a guard timer of
  the clip's duration plus a margin. If audio fails for any reason the
  conversation continues slightly early rather than stopping forever. A voice
  loop must not be able to deadlock on its own output device.
