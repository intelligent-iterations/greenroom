# Benchmarks

## How to run it

```bash
pnpm --filter @greenroom/web build
pnpm --filter @greenroom/web exec vite preview --port 5179
# then open http://localhost:5179/bench.html?model=<mlc-model-id>
```

`bench.html` drives the **production adapters** — the same recogniser, model and
synthesiser the app uses, and the same prompt compiler. Only the microphone is
replaced, by pre-recorded 16kHz utterances in `packages/web/public/bench/`, so a
run is reproducible and can be driven headlessly. Results land on the page and
on `window.__BENCH__` for an automation driver to read.

Two things to know before trusting a number from it:

- **Use the preview build, not the dev server.** Vite's HMR and dep optimiser
  reload the page mid-download, which restarts the run.
- **Changing port invalidates everything.** The Cache API is keyed by origin, so
  moving from :5178 to :5179 re-downloads every model.

## Verify models load before benchmarking them

```bash
pnpm --filter @greenroom/web verify:models
```

Presence in WebLLM's `prebuiltAppConfig` does **not** mean a model can be
downloaded. MLC publishes the compiled WASM library and the weights as separate
artifacts, and at the current pin Qwen3.5 (0.8B/2B/4B) and Ministral 3 have
libraries published while their weight repositories return 404 for
`ndarray-cache.json`. WebLLM reports this as `Cache.add() encountered a network
error`, tens of seconds into a session.

We shipped a unit test asserting the model id existed in `prebuiltAppConfig`. It
passed, and the model still could not load. Verifying the wrong thing is worse
than not verifying, because it buys confidence.

## Status

**Latency figures in the model catalogue are measured on a single machine**
(Apple M-series, Metal-3, Chrome, 10 threads, `maxBufferSize` 4095MB). One
machine is not a distribution: treat them as a point sample that establishes
ordering and rough magnitude, not as a p50 across the install base. The hardware
profiles below are still worth covering.

The latency and quality figures in `packages/web/src/voice/models.ts` are seed
values. They encode the ordering the design assumes — on-device is fastest to
first token and weakest on instruction-following, hosted models are the reverse
— so that the router behaves sensibly before anyone has benchmarked anything.
They are labelled as seed values in the source, and they should be replaced with
real numbers before any of this is treated as a deployment decision.

This document describes the measurement to run. It is written as a spec so that
the numbers, when they exist, are comparable across runs and machines.

## What to measure

Two independent things, often confused:

**Latency** is a property of a model *on a device*. It must be measured on
representative target hardware, not on a developer laptop, and reported as a
distribution rather than a mean — the p95 is what makes learners talk over the
interviewer, and a mean hides it.

**Quality** is a property of a model *against a task*. It is measured by the
eval harness in `evals/`, not by a benchmark script, and it is the composite
score from a live run.

## Latency protocol

Per stage, anchored the way the product anchors them:

| Metric | From | To |
|---|---|---|
| `sttMs` | VAD declares speech ended | transcript in hand |
| `firstTokenMs` | VAD declares speech ended | first LLM token |
| `firstAudioMs` | VAD declares speech ended | first audible sample |
| `turnaroundMs` | VAD declares speech ended | interviewer stops speaking |

`firstAudioMs` is the number that governs perceived responsiveness; the others
exist to attribute a regression to a stage.

The app already instruments all four (`TurnTimings`) and surfaces the median in
the session UI, so the fastest honest benchmark is a scripted set of interview
sessions with the timings exported, rather than a synthetic harness that
measures a different code path from the one that ships.

Report, per hardware profile:

- p50 and p95 for each metric
- cold-start separately from warm — first-run weight download and shader
  compilation are a different user experience and should not be averaged in
- peak GPU memory across all three on-device stages simultaneously, which is the
  binding constraint on model selection

Hardware profiles worth covering, in priority order:

1. A mid-range 2022-2024 laptop with integrated graphics — the realistic median.
2. A machine with **no** WebGPU, exercising the WASM path, with and without
   cross-origin isolation. The delta between those two is the value of the COOP
   /COEP headers and is worth knowing precisely.
3. A discrete-GPU machine, for the ceiling.

## Open questions the benchmark should settle

- **Whisper base vs small.** Base is the default because it is the smallest
  Whisper that stays usable on the CPU path. Small is more accurate; if its
  latency fits on profile 1, it should win. Run both through the eval set and
  compare word error rate on accented speech specifically, not overall.
- **Qwen3.5 2B vs 0.8B vs 4B.** The one that decides the product's feel. The
  router currently filters at 400ms to first token using seed values; measuring
  the real figures on profile 1, with Whisper and Kokoro resident, either
  confirms the default or moves it. Report first-token and decode throughput
  separately — a model can start fast and then speak too slowly to keep up with
  the synthesiser.
- **Does disabling thinking actually eliminate the latency?** Compare
  `enable_thinking: false` against the default on identical prompts, measuring
  first token and total turn. This is the largest single latency variable in the
  current design and it has not been measured.
- **Ministral 3 3B and Phi-4-mini** as alternatives to Qwen3.5 2B: both are in
  the prebuilt list, both are larger, and neither has been through the eval set.
- **Kokoro dtype.** fp32 vs q8 on WebGPU: does the quantised voice free enough
  memory to matter, and is the quality cost audible?
- **VAD `redemptionMs`.** Currently 800ms, reasoned rather than measured. Wants
  tuning against recorded learner audio per CEFR band; the right value is
  probably not one value.

## Vendor comparison

For hosted models, run the same eval set through each provider and compare on
identical inputs:

```bash
pnpm --filter @greenroom/evals exec node --experimental-strip-types src/cli.ts \
  --backend=azure --judge=gemini
pnpm --filter @greenroom/evals exec node --experimental-strip-types src/cli.ts \
  --backend=gemini --judge=gemini
```

Hold the judge fixed across both runs. Comparing two models scored by two
different judges measures the judges.

Report composite, per-dimension means, critical failures, and cost per session
at the median turn count. Cost belongs in the comparison because at classroom
scale it is frequently the deciding term, and it is the one number that is
trivially measurable and routinely omitted.
