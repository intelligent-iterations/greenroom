# ADR 0001: On-device inference is the default, not a mode

**Status:** accepted
**Date:** 2026-09-05

## Context

The product is a spoken interview rehearsal tool. Learners record themselves
being bad at explaining their worst professional decisions, in a second
language, while nervous. The content is unusually sensitive for what looks like
a productivity app.

The deployment context is a training platform used at federal scale in Canada,
where data residency review is a real gate on real timelines, not a formality.

Browser inference is now genuinely viable for this workload: WebGPU is broadly
shipped, a 1.7B instruct model produces acceptable interviewer turns, Whisper
base runs in a tab, and neural TTS fits in under 100M parameters.

## Decision

On-device inference is the default path. Cloud inference exists, is behind an
explicit per-session opt-in, and is never entered silently.

## Consequences

**Good.**

- The privacy question stops being a policy question. There is no data to
  mishandle because none is transmitted.
- Residency review becomes short. A deployment with no inference egress does not
  need a regional argument.
- Cost per session is zero at the margin, which changes what is affordable at
  classroom scale.
- It works offline, which matters more than expected for training delivered in
  buildings with hostile networks.

**Bad, and accepted.**

- A 1.7B model is meaningfully weaker at instruction-following than a hosted
  frontier model. Some of that gap is recoverable in the prompt layer; not all
  of it. This is the real cost of the decision.
- A ~1.2 GB first-run download. Mitigated by browser caching, but it is a bad
  first thirty seconds and no amount of UI fixes that.
- No WebGPU means no on-device interviewer. There is no CPU fallback for the LLM
  stage because one would be too slow to be a conversation (see
  ADR 0002 and the LLM adapter's comments). Those users must consent to cloud
  inference or be told plainly that the device cannot do it.
- Three models resident in one tab makes GPU memory the binding constraint on
  every model choice, permanently.

## Alternatives rejected

**Cloud-first with an on-device option.** The defaults are the product. An
opt-in privacy mode that most users never find provides the engineering cost of
on-device inference with none of the benefit.

**On-device speech, cloud LLM.** Tempting, since STT is the heaviest privacy
component and the LLM is where quality is lost. Rejected because the transcript
is the sensitive artefact, not the waveform. Sending a perfect transcript of the
learner's answers to a third party is the thing we are trying to avoid; the
audio is merely how it starts.
