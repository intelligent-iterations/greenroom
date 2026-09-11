# Architecture

## The one-sentence version

A cascaded voice loop runs entirely in the browser tab, driven by an
orchestrator that depends only on narrow stage interfaces; everything
user-specific enters through one pure prompt compiler; anything that must leave
the device goes through a single server endpoint that logs where it went.

## Why the shared package exists

`packages/shared` is not a utility bin. It holds the four things that three
different surfaces must agree on exactly:

- the **domain model** (learner state, competencies, sessions),
- the **prompt compiler**,
- the **rubric**,
- the **scenario catalogue**.

The browser renders scenarios and compiles prompts. The scoring Cloud Function
recompiles the *same* prompt to recover which competencies a session was
training. The eval harness replays the same scenarios through the same compiler.
A second copy of any of these means the harness eventually measures something
that never shipped, and the scorer eventually credits a competency the session
never probed.

Consumers import the **built** output (`dist/`), not the TypeScript source. That
is deliberate: the Cloud Functions runtime and the eval CLI are plain Node, and
a package that only works inside a bundler cannot be deployed. `pnpm build:shared`
runs before typecheck, test and dev for this reason.

## The voice loop

```
VAD.onSpeechEnd(audio)
  └─ STT.transcribe            ── sttMs
      └─ (drop if < 2 chars: Whisper hallucinates "Thank you." on silence)
      └─ append learner turn
          └─ LLM.generate(messages, signal)     ── firstTokenMs
              ├─ accumulate → splitSpeakableChunks
              │     └─ enqueue each sentence on the serial speak queue
              │           └─ TTS.speak(chunk, signal)   ── firstAudioMs
              └─ on stream end: flush the remainder    ── turnaroundMs
```

Concurrency notes that matter:

**One AbortController per interviewer turn**, passed to both the model and the
synthesiser. Barge-in aborts it once and both stages stop.

**The speak queue is a promise chain, not an await.** Generation continues while
audio plays; overlapping them is the entire latency win. The chain's `.catch`
swallows abort errors and reports real ones without rejecting the chain — a
rejected queue promise would silently swallow every later sentence.

**A barged-in turn records what was spoken, not what was generated.** Otherwise
the transcript claims the interviewer asked something the learner never heard,
and the next turn follows a thread that does not exist in the conversation.

**Timings anchor to VAD close**, not mic-open. See the comment on `TurnTimings`.

## Stage selection

| Stage | WebGPU present | No WebGPU |
|---|---|---|
| VAD | Silero v5 (ONNX, small enough either way) | same |
| STT | Whisper base, encoder fp32 + decoder fp32 | Whisper base, encoder fp32 + decoder q8, threaded WASM |
| LLM | transformers.js (SmolLM2 1.7B, q4f16) | **no on-device option** — cloud, with consent |
| TTS | Kokoro-82M (English only) | platform speech synthesis |

Two of these deserve explanation.

**There is no CPU fallback for the LLM.** A 1.7B model decoding on WASM is far
outside the conversational budget. A voice partner that takes several seconds to
start replying is not a slower product, it is a worse and different one. Without
a GPU the app asks for consent to use a cloud model, and if refused it says so
plainly rather than degrading into something unusable.

**Kokoro is English-only in v1.0**, so French scenarios use the platform
synthesiser regardless of GPU. The voice type is derived from the library's own
voice map, so adding a French voice later is a one-line change the compiler
checks.

## Cross-origin isolation

`onnxruntime-web` only uses multi-threaded WASM when `SharedArrayBuffer` is
available, which requires `Cross-Origin-Opener-Policy: same-origin` and a COEP
header. On the CPU fallback path — the one that needs the help most — this is
the difference between usable and not.

COEP is set to `credentialless`, not `require-corp`: model weights are fetched
cross-origin from the Hugging Face CDN, which does not send CORP headers, and
`require-corp` blocks them outright.

These headers are set in **two** places that must agree — `vite.config.ts` for
dev, and `firebase.json` for production hosting. A mismatch means the fallback
path silently runs several times slower in production than in dev, with no
error anywhere.

## The learner-state layer

Local storage is the source of truth for a session in flight; Firestore is sync,
not a dependency, because a dropped network must not end an interview. Merge is
last-write-wins on `updatedAt` — sessions are minutes long and a learner is on
one device at a time, so anything cleverer is unearned complexity.

**Mastery is server-authoritative.** It decides what the learner is asked next,
so a client that could write it could choose its own curriculum. `firestore.rules`
rejects any client write touching `mastery`, `recentErrors` or
`sessionsCompleted`; the `onSessionCreated` trigger runs with Admin credentials
and is the only writer. Session documents are append-only for the same reason:
a transcript that can be edited after the fact is not evidence, and the scorer
reads it as evidence.

When no cloud provider is configured, scoring is skipped and mastery simply does
not move. That is the correct failure — a fabricated score is worse than a
missing one.

## Bundle strategy

Every heavy adapter is behind a dynamic import. Statically, transformers.js,
the ONNX runtime and Kokoro are ~9 MB of JavaScript downloaded before the setup
screen can render a button. Deferring them to the moment a session starts takes the initial
chunk to ~862 KB, and the cloud path never pays for the on-device runtimes it
does not use.

This is also why `vad.types.ts` is split from `vad.ts`: the orchestrator needs
only the interface, and importing the implementation for a type would pull
onnxruntime into the entry chunk and into headless test import graphs.
