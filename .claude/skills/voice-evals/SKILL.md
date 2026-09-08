---
name: voice-evals
description: Write held-out evaluation cases for a spoken conversational agent, run them, and read the result. Use when someone asks how to evaluate a voice agent or a conversational LLM, wants test cases or a regression suite for one, is setting up a quality gate for generative dialogue, or has a voice agent that "feels worse" and needs that turned into a number.
---

# Evaluating a spoken conversational agent

Generative dialogue has no correct answer to diff against, so the instinct to
write expected outputs produces a suite that fails on paraphrase and passes on
nonsense. Score **properties of a turn** instead, in two layers with a strict
division of labour: rules that are decidable, and judgement that is not.

Reference implementation in this repository: the runner and case loader in
`evals/src/runner.ts`, the judge in `evals/src/judge.ts`, the gates in
`evals/src/gate.ts`, the anchored rubric in `packages/shared/src/rubric.ts`, and
worked cases in `evals/datasets/interviewer-adversarial.jsonl`.

## Cases are situations, not expected answers

A case describes the circumstances and what it probes. It never carries a
correct reply.

```json
{"id": "vague-impact-followup",
 "probes": "Learner claims impact with no numbers. The turn must press for the figure.",
 "transcript": [{"role":"user","text":"I optimised it and it got a lot faster."}]}
```

If you find yourself writing an `expected` field, stop: you are building a
brittle string match with extra steps.

## Cover the adversarial half — it is the half that matters

Ordinary-path cases mostly pass and mostly stay passing. The interesting set:

- asking the agent to break character or reveal its instructions
- a prompt injection, including one **inside a document the agent retrieves**
- a request the agent should decline
- **a legitimate request a badly-tuned agent would wrongly refuse** — the case
  that catches over-refusal, which nobody writes and everybody needs
- the user going silent, vague, or off-topic
- contradicting something the agent was told

### An adversarial case that cannot reach the model is decoration

Verify the case actually exercises what it claims. In this repo two grounding
cases silently tested nothing: one retrieved zero passages because the lexical
retriever could not connect "MySQL" to "Postgres", and the injection case never
surfaced the injection because a relevance floor suppressed it. Both looked
fine in the dataset and in the report. **Print what the model was actually
given before trusting a case.**

## Two layers

**Deterministic checks** run on every turn, cost nothing, never flake. Anything
decidable by a rule belongs here — see the `voice-checks` skill.

**An LLM judge** scores an anchored rubric, and is built to be distrusted:

- temperature 0, fixed rubric, anchors written at 1 / 3 / 5 so the scale means
  something and the judge cannot cluster everything at 3
- show it the agent's **own system prompt**, so difficulty and register are
  scored against the stated bar rather than the judge's taste
- **every score must quote the turn, and verify the quote appears in it.**
  Requiring a quote constrains the judge to the text; verifying it is what makes
  the requirement more than a suggestion. Discard unverifiable scores, retry if
  most of a verdict goes, and error rather than scoring zero — a zero looks
  exactly like a catastrophic regression and sends someone to bisect a prompt
  that was fine.
- **score only what the agent was actually given.** A dimension about using
  retrieved context must be dropped from the rubric entirely when there was no
  context, not scored low. Otherwise it means nothing and drags the dimension
  mean under its floor on every case that had nothing to ground against.
- an explicit anti-length instruction. Judges reward longer answers, which is
  backwards for anything read aloud.

## Quality gates

Fail a build on: any critical-dimension failure regardless of the average; a
composite below a floor; any single dimension below its floor; a regression
beyond tolerance against a recorded baseline.

Critical failures are absolute because averaging a measured harm away across
forty passing cases is how a product ships one it already knew about.

**Gate the cheap layer on every commit and the expensive one on demand.**
Deterministic checks against stored turns need no credentials, so they can gate
every pull request. Gating every commit on a paid non-deterministic judge trains
people to ignore the gate.

## Baselines

A baseline is written **only from a clean run** — no errors, no critical
failures. Baselining a failing run records a failure as the thing not to
regress from.

Note what replay does and does not prove: replaying stored turns cannot catch a
model regression however realistic those turns are, because it is deterministic
by construction. It catches prompt and check regressions. The **baseline** is
what detects a model regression, and only a live run exercises it.

## Running it here

```bash
pnpm eval                     # offline, deterministic only, no credentials
pnpm eval:gate                # same, as a pass/fail gate
pnpm --filter @greenroom/evals exec node --experimental-strip-types \
  src/cli.ts --backend=openrouter --judge=openrouter --gate
```

Backends: `replay` (default), `openrouter`, `azure`, `gemini`, `local`.
Useful flags: `--tag=`, `--limit=`, `--style=`, `--record`, `--write-baseline`.

## Reading a result

Look at the **worst dimension**, not the composite. A composite of 0.905 with
one dimension at 3.5 means the thing you just built is the thing that does not
work. Then check whether any failure is the harness rather than the model — an
errored case is usually credentials or a budget, not quality.

And let the gate fail. A gate that is never allowed to go red produces no
information; the run in this repo that failed is the one that produced a usable
vendor result.
