# Benchmarks

## Status

**No measured benchmark run is committed to this repository.**

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
- **Qwen3 1.7B vs Llama 3.2 1B.** Quality against latency and memory, on
  profile 1, with the other two stages resident.
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
