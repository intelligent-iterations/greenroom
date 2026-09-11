# Contributing

## Getting it running

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # every package
pnpm typecheck
pnpm eval         # the harness, offline, no credentials
```

Node 22+, pnpm 10+. A Chromium-based browser or Safari 18+ with WebGPU for the
app itself; the tests and the harness need neither.

## What this project is fussy about

Three things, and they are the reason the code reads the way it does.

**A check that cannot fail is worse than no check.** It looks like coverage and
buys confidence it has not earned. If you add a deterministic check, add the
test that proves it fires *and* the test that proves it stays quiet — and then
confirm it is actually reachable from the harness. Two checks sat in every
report for months unable to fire because the runner never passed them their
context.

**Say what you have not verified.** The README has a "what is verified and what
is not" section and it is the most valuable thing in the repository. If you add
something you have not run against real hardware, real audio or a real vendor,
put it in the second list. A number nobody measured does not go in the first
list because it would be nice if it were true.

**Rules go in checks, judgement goes in the rubric.** Anything decidable belongs
in `packages/shared/src/checks.ts`, tuned for precision, because a false
positive fails a build and teaches people to ignore the suite. Anything needing
judgement belongs in the rubric with anchors written at 1, 3 and 5.

There are three agent skills in `.claude/skills/` that carry the rest of this in
more detail — `voice-evals`, `voice-checks`, `voice-pipeline`. They are written
for an agent but they read fine as prose.

## The shape of the codebase

`packages/shared` is **the core**: everything true of any spoken agent — checks,
rubric, judge prompt, retrieval, pipeline interfaces, routing. It does not know
what an interview is, and `boundary.test.ts` fails if that stops being true.

`packages/shared/interview` is **the worked example**, behind its own entry
point. New domains should look like it: a pack of checks, a pack of rubric
dimensions, and whatever prompt compiler that domain needs.

If you are adding support for a new kind of agent, you probably want a new pack
rather than a new field on an existing type.

## Pull requests

CI runs typecheck, every test, the Firestore rules against a real emulator, a
web build, and the evaluation gate. All of it has to pass, including the gate.

Prompt changes need a `PROMPT_VERSION` bump — the compiled output is snapshot
tested, so a change you did not intend shows up in the diff rather than in a
score three weeks later.

Commit messages here explain *why*, at some length, and often record the thing
that was wrong before. That is deliberate: the reasoning is the part that decays
first and is hardest to recover.
