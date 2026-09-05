# ADR 0005: Qwen3.5 2B as the realtime interviewer, chosen under a latency ceiling

**Status:** accepted
**Date:** 2026-09-05
**Supersedes:** the model choice in ADR 0001, not its reasoning

## Context

The on-device interviewer has to hold a spoken conversation. That makes model
selection a latency problem before it is a quality problem, which inverts how
these decisions are usually made.

Two constraints are not negotiable:

1. **It has to be compiled for the browser.** A model can only run here if MLC
   has compiled it to WebGPU shader libraries and published it in WebLLM's
   `prebuiltAppConfig`. At the pinned version that includes Qwen3.5
   (0.8B/2B/4B/9B), Ministral 3 3B, Phi-4-mini, Llama 3.2, SmolLM2 and Gemma up
   to 3. It does **not** include Gemma 4, which is otherwise a serious
   contender in this class. "Best small model" is always "best small model
   somebody compiled".
2. **Three models share one tab.** Whisper and Kokoro take GPU memory before the
   interviewer gets any, so a model that fits alone can still fail in situ.

## Decision

**Qwen3.5 2B** (`Qwen3.5-2B-q4f16_1-MLC`, ~2.2GB) is the default on-device
interviewer, selected by policy rather than hardcoded:

- First-token latency is a **hard filter** at 400ms, derived from the pipeline's
  ~800ms first-audio budget minus what recognition and synthesis need.
- Quality is the **tie-break** among models that pass.
- Available GPU memory filters too, using the adapter's `maxBufferSize` as a
  proxy minus the other stages' share.

So the router picks the best model that can still answer in time and fit. On a
constrained device it lands on 0.8B; the 4B is rejected on latency and says so.

Thinking is disabled per request, and `<think>` blocks are stripped from the
stream regardless.

## Rationale

**Why 2B and not 0.8B.** The interviewer's job is almost entirely
instruction-following: stay in role, withhold the answer, pitch difficulty to a
stated seniority, speak within a CEFR ceiling, ask one question. Those are
exactly what the rubric scores and exactly what degrades first as models shrink.
0.8B is faster and materially weaker on that; it is the constrained-device
fallback, chosen on constraint rather than preference.

**Why not 4B.** It is the better model and it loses on the only axis that
defines this feature. At ~620ms to first token it blows the budget before
recognition and synthesis have taken their share, and it needs ~3.9GB.

**Why the latency ceiling is a filter rather than a weight.** Weighted scoring
would let a large quality advantage buy a latency regression. In a voice product
that trade is not available: past roughly a second of silence learners assume it
failed and start talking over it, and no amount of answer quality recovers a
conversation that has stopped feeling like one.

**Why thinking suppression is treated as a correctness issue.** A leaked
reasoning block is not degraded output, it is the synthesiser speaking the
model's private deliberation to the learner in the interviewer's voice. Belt and
braces is proportionate.

## Consequences

- The catalogue is pinned to a WebLLM version. A version bump can add or remove
  models, so a test asserts every on-device id exists in `prebuiltAppConfig` and
  that declared VRAM matches the runtime record. Without it, a stale id fails at
  session start on someone else's machine.
- The latency figures driving the filter are seed values. This is the sharpest
  open risk in the design: the ceiling is principled, the numbers it compares
  against are not yet measured. `docs/BENCHMARKS.md` describes the run.
- `maxBufferSize` is a proxy for available memory, not a measurement of it —
  WebGPU exposes no VRAM figure by design. WebLLM's own load-time check remains
  the backstop.
- Gemma 4 is worth revisiting whenever MLC compiles it.
