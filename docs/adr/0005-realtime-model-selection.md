# ADR 0005: transformers.js for on-device generation, and verifying artifacts before running

**Status:** accepted
**Date:** 2026-09-05
**Refines:** ADR 0001 (on-device first)

## Context

The on-device interviewer has to hold a spoken conversation, which makes model
selection a latency problem before it is a quality problem. Two runtimes can run
an LLM in a browser: **WebLLM/MLC** (models compiled to WebGPU shader libraries)
and **transformers.js** (ONNX Runtime Web, weights loaded from Hugging Face).

We started on WebLLM with Qwen3.5 2B, the newest small model in MLC's registry.

## What went wrong

The catalogue entry was guarded by a unit test asserting the model id existed in
MLC's `prebuiltAppConfig`. The test passed. **The model could not load.**

MLC publishes the compiled shader library and the weights as *separate*
artifacts. For Qwen3.5 (0.8B, 2B, 4B) and Ministral 3 the libraries are
published and the weight repositories return **404 for `ndarray-cache.json`**,
the shard manifest. WebLLM reports this as `Cache.add() encountered a network
error` — opaque, tens of seconds into a session, on the learner's machine.

Only running the pipeline end to end on real hardware found it. The unit test
verified the wrong thing, which was worse than verifying nothing, because it
bought confidence.

## Decision

**Move on-device generation to transformers.js**, using
`HuggingFaceTB/SmolLM2-1.7B-Instruct` at `q4f16` on WebGPU, and **declare every
on-device artifact in one manifest that both the adapters and a preflight
checker read.**

The stage configuration — models, dtypes, devices — matches Hugging Face's
[`conversational-webgpu`](https://github.com/huggingface/transformers.js-examples/tree/main/conversational-webgpu)
example, a published working in-browser voice chat on precisely this stack.

## Rationale

**The artifact verified is the artifact fetched.** transformers.js loads ONNX
weights straight from a Hugging Face repository, so a HEAD request against the
URL the adapter will use is a complete proof of availability. MLC's two-artifact
split makes that impossible to check from the id alone — which is the bug.

**One runtime instead of two.** Recognition, generation and synthesis now share
one ONNX runtime and one browser cache. It also removed a 6 MB dependency.

**Matching a proven configuration beat reasoning about it.** Where we had
diverged from the reference, we were wrong twice: the unloadable LLM, and a
single `fp16` dtype for Whisper that quantised the *encoder*. Encoder precision
governs accuracy on accented speech — the entire population this product serves.
Per-module dtypes now come from the manifest.

**Non-reasoning by default.** SmolLM2 does not deliberate before answering,
which for a voice interviewer removes both the silence and the risk of
deliberation reaching the synthesiser. The `<think>` stripper stays regardless,
because the router can select reasoning-capable models and the failure mode is
the learner hearing the model's private reasoning in the interviewer's voice.

**Latency stays a hard filter.** `REALTIME_FIRST_TOKEN_BUDGET_MS` is derived
from the pipeline's first-audio budget. A larger model is always available and
always better; the reason not to use it is that a late reply stops being a
conversation. Quality decides only among models fast enough.

## Consequences

- `pnpm preflight` resolves the manifest to concrete URLs and checks all fifteen
  in seconds, with no GPU and no downloads. It immediately found that
  `onnx-community/silero-vad` ships no `config.json`, which is why the loader is
  handed one inline.
- `onnxFileName(module, dtype)` is pure and total, so the mapping is unit-tested
  offline — including that `q8` becomes `_quantized`, not `_q8`. Static proof
  and network proof are separate layers.
- **Qwen3.5 remains the model to adopt when its weights land.** It is newer and
  better and already compiled; only the upload is missing. MLC could be
  reintroduced behind the same `LanguageModel` interface, but it would need its
  own preflight covering both artifacts.
- The manifest is now a single point of truth that can go stale against
  upstream. Preflight is the guard, and it belongs in CI on a schedule rather
  than on every commit, since it depends on the network.
