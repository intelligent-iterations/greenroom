# Greenroom

**Build a voice agent, then find out whether it is any good — without either
half leaving your machine.**

Live: **https://greenroom-ii.web.app**

Two things in one repository, and the second is the durable one.

**A voice pipeline that runs in a browser tab.** You talk, it answers, you
interrupt it mid-sentence and it stops. Speech recognition, the language model
and the voice all run locally; on a machine with WebGPU, no audio and no
transcript leaves the device. Pick one of four bundled model tiers from 260 MB
to 2.7 GB, any Hugging Face repository with ONNX weights, or a folder you
already have on disk.

**An evaluation harness for spoken agents**, which is the part worth reusing.
Voice failures are not chat failures: markdown read aloud as "asterisk", three
questions stacked into one turn nobody can hold, a reply that never hands the
floor back. So the checks are voice-specific, composed per agent — a support bot
must not be failed for answering rather than asking — and what needs judgement
goes to an anchored rubric whose scores must quote the turn. Bring your own
agent as a system prompt, your own cases as JSONL or a CSV, and gate a build on
the result.

The core knows nothing about any particular kind of agent. Interview coaching is
the worked example that proves the core is usable, behind its own entry point,
and a test fails if it leaks back.

Three agent skills ship in `.claude/skills/` so an agent working on *your* voice
product starts with the judgement this one paid for.
---

## Contents

- [What it does](#what-it-does)
- [Run it](#run-it)
- [Architecture](#architecture)
- [The voice pipeline](#the-voice-pipeline)
- [Pedagogical calibration](#pedagogical-calibration)
- [Grounding](#grounding)
- [Model portability](#model-portability)
- [Evaluation harness](#evaluation-harness)
- [Agent skills](#agent-skills)
- [Infrastructure and deployment](#infrastructure-and-deployment)
- [Project status: what is verified and what is not](#project-status-what-is-verified-and-what-is-not)
- [Repository map](#repository-map)

---

## What it does

Pick a scenario — backend engineer, customer service advisor in French, senior
product manager — and have a spoken interview with it. The interviewer stays in
character, asks the questions the scenario requires, and follows up on the parts
of your answer you left vague. You can interrupt it mid-sentence and it stops,
because that is how conversation works.

Afterwards it writes you three short paragraphs of feedback that quote what you
actually said.

Two things make it a training tool rather than a chatbot with a microphone:

**Language level and difficulty are separate axes.** The interviewer speaks at
your CEFR level, and asks questions at the seniority you are targeting. A strong
engineer rehearsing in their second language gets reachable *wording* and
undiminished *questions*. Collapsing those two things is the obvious
implementation and it patronises exactly the people the tool is for.

**It remembers what you are bad at.** Per-competency mastery estimates decide
what the next session steers toward, and a weakness that survives two sessions
gets one — deliberately only one — natural opportunity to do better.

## Run it

Requires Node 22+ and pnpm 10+. No accounts, no API keys, no backend.

```bash
pnpm install
pnpm dev
```

Open the printed URL in a Chromium-based browser or Safari 18+, allow
microphone access, and start talking.

The first run downloads about 1.6 GB of model weights and caches them in the
browser — Whisper base for recognition (276 MB), SmolLM2 1.7B at q4f16 for the
interviewer (1057 MB), and Kokoro for the voice (310 MB). After that it works
with the network off.

Before downloading anything, you can check the whole model set resolves:

```bash
pnpm --filter @greenroom/web preflight
```

**Headphones are strongly recommended.** The microphone stays open while the
interviewer speaks so you can interrupt it; on laptop speakers this leans hard
on the browser's echo cancellation.

**No WebGPU?** The setup screen says so before anything downloads, and says what
it can still do. Speech recognition falls back to multi-threaded WASM and the
voice falls back to the platform synthesiser; the language model is the stage
where a GPU is the difference between a conversation and a wait, so a CPU-only
machine is told to expect several seconds per reply rather than about 1.2s — and
told that this is an estimate, because no CPU-only run is recorded. If neither
WebGPU nor SharedArrayBuffer is available, nothing here will work, and the screen
says that plainly with a list of things to try rather than greying out a model
list and leaving you to infer why.

The verdict is a pure function of detected capability
([`readiness.ts`](packages/web/src/voice/readiness.ts)), so every branch is
tested without a GPU — including the one that says a GPU is present but its
single-buffer limit is smaller than the smallest bundled model, which is a real
constraint rather than a proxy for one.

Other useful commands:

```bash
pnpm test         # 357 unit tests across five packages
pnpm typecheck    # every package
pnpm eval         # run the evaluation harness offline
pnpm eval:gate    # the same run, as a pass/fail quality gate
```

## Architecture

```
┌──────────────────────── browser ─────────────────────────────┐
│                                                              │
│   mic ──▶ VAD ──▶ Whisper ──▶  LLM  ──▶ Kokoro ──▶ speaker   │
│         (Silero)  (on-device) (on-device) (on-device)        │
│            │                    ▲   │                        │
│            └──── barge-in ──────┘   │                        │
│                                     │                        │
│              InterviewSession  ─────┘                        │
│              (orchestrator, packages/web/src/voice)          │
│                      │                                       │
│              compiled prompt ◀── learner state               │
│                      │                                       │
└──────────────────────┼───────────────────────────────────────┘
                       │  (only if the learner opts in)
┌──────────────────────▼──────── Cloud Functions ──────────────┐
│  /api/generate   SSE proxy → Azure OpenAI | Gemini           │
│  onSessionCreated  scores answers, updates mastery           │
└──────────────────────┬───────────────────────────────────────┘
                       │
                  Firestore (learner state, transcripts)
```

Five packages, split along one boundary that matters more than the others: the
**core** is everything true of any spoken agent, and interview coaching is one
**worked example** behind its own entry point. Someone evaluating a support bot
should never have to see a CEFR level to use the harness, and a test asserts
they do not — `packages/shared/src/__tests__/boundary.test.ts` fails if a single
interview symbol leaks back into `@greenroom/shared`.

| Package | What it is |
|---|---|
| `packages/shared` | **The core.** Checks, rubric, judge prompt, retrieval, pipeline interfaces, routing policy — everything true of any spoken agent. |
| `packages/shared/interview` | **The worked example.** CEFR, seniority, competencies, mastery, and the interviewer prompt compiler. A separate entry point, not re-exported by the core. |
| `packages/web` | React app and the voice pipeline. |
| `packages/functions` | Firebase Cloud Functions: the cloud-inference proxy and server-side scoring. |
| `packages/rules` | Firestore security rules, under test against the emulator. |
| `evals` | Evaluation harness, test sets, quality gates. |

Firebase is entirely optional. With no config the app runs local-only: bundled
scenarios, learner state in `localStorage`, on-device inference, no network.

## The voice pipeline

Cascaded — speech recognition, then a language model, then speech synthesis —
rather than a native realtime API. The reasoning is in
[ADR 0002](docs/adr/0002-cascaded-vs-realtime.md); the short version is that no
realtime voice API runs on-device, so choosing one would mean giving up the
premise.

The duplex seam exists anyway, in `duplex.ts` and `realtime-session.ts` — a
parallel orchestrator rather than an extension of the cascade, because ADR 0002
predicted that realtime would replace the orchestrator rather than reconfigure
it, and pretending one abstraction covered both would be the worse lie. Building
it produced the strongest argument in that ADR, which reasoning about it had not:
**a duplex session sets its prompt once at socket open and cannot recompile per
turn**, so per-turn coverage steering and all of the retrieved grounding below
are lost in the switch. It has never talked to a vendor; see the project-status
section.

A cascade is easy to build badly. Two things make it feel live rather than like
a walkie-talkie:

**Sentence-level handoff.** Waiting for the full model response before speaking
adds a second or more of dead air. The orchestrator splits the token stream at
sentence boundaries and starts synthesising the first sentence while the model
is still writing the second (`splitSpeakableChunks`, with the fiddly cases —
decimals, abbreviations, short fragments — under test).

**Barge-in.** Speech detected during playback aborts the model stream and stops
audio in the same tick. Being interruptible is most of what makes a voice agent
feel like a conversation rather than a phone tree.

### Verifying the pipeline before running it

Every on-device stage is declared once, as data, in
[`model-manifest.ts`](packages/web/src/voice/model-manifest.ts): the repository,
the ONNX modules it loads, and the quantisation per device. The adapters read
that manifest and so does `pnpm preflight`, so the configuration that gets
verified is the configuration that gets fetched.

This exists because of a bug that cost a rewrite. The interviewer was
originally Qwen3.5 2B on WebLLM/MLC, guarded by a unit test asserting the model
id existed in MLC's registry. The test passed. The model could not load — MLC
publishes compiled shader libraries and weights as separate artifacts, and for
Qwen3.5 and Ministral 3 the weights are simply missing (`ndarray-cache.json`
returns 404). It surfaced as an opaque `Cache.add()` error, tens of seconds into
a session. **Verifying the wrong thing was worse than not verifying, because it
bought confidence.**

There are now two layers, both deterministic and neither needing a GPU:

- **Offline unit tests.** `onnxFileName(module, dtype)` is pure and total, so a
  URL is fully determined by the manifest. The tests pin the mapping, including
  that `q8` becomes `_quantized` rather than `_q8`.
- **`pnpm preflight`.** Resolves the manifest to concrete URLs and HEAD-checks
  all twenty-five in a few seconds.

Preflight has already earned it: it found that `onnx-community/silero-vad` ships
no `config.json`, which is why the loader is handed one inline.

The stage configuration — models, dtypes, devices — matches Hugging Face's
[`conversational-webgpu`](https://github.com/huggingface/transformers.js-examples/tree/main/conversational-webgpu)
example, a published working in-browser voice chat on this stack. Two places
where we had diverged were both wrong: the LLM (unloadable, as above) and the
Whisper dtype, where a single `fp16` was quantising the *encoder* — the
component whose precision governs accuracy on accented speech, which is the
entire population this product serves.

### Making it feel realtime

Three things beyond the cascade itself, all aimed at the gap between the learner
falling silent and the first spoken word:

**Latency is a hard constraint on model choice, not a preference.** The router
rejects any model whose first-token latency exceeds the budget the pipeline can
afford, then picks the *best* model among what is left. A larger model is always
available and always better; the reason not to use it is that a reply which
arrives late stops being a conversation. When the 4B is rejected for being
620ms to first token, the UI says so.

**Reasoning output never reaches the speaker.** The default interviewer is
non-reasoning, which is part of why it was chosen. But the router can select
reasoning-capable models, and a leaked `<think>` block is not degraded output —
it is the synthesiser reading the model's private deliberation to the learner in
the interviewer's voice. So the stream is filtered regardless, by a stateful
stripper, because tags arrive split across deltas (`<thi` in one, `nk>` in the
next) and a stateless regex emits the halves.

**The first chunk of a turn may break at a clause.** Normally audio waits for a
complete sentence, which sounds better. Until a turn has made any sound, a comma
will do — starting a sentence earlier is worth more than the prosody it costs.
Once it is speaking, sentence boundaries resume.

There is also a warm-up: the model runs one throwaway generation during the
loading screen so shader compilation does not land on the opening question.

Barge-in creates its own problem: the microphone is open while the interviewer
talks, so the interviewer hears itself and interrupts itself, and the session
livelocks on turn one. That is handled in two places — the audio stream is
opened with echo cancellation by *this* code rather than by the VAD library, and
there is a short guard window after playback starts during which detected speech
is ignored while the browser's AEC converges.

Every stage sits behind a narrow interface in
[`packages/shared/src/pipeline.ts`](packages/shared/src/pipeline.ts). The
orchestrator depends on those interfaces and nothing else, which is what lets
the concurrency — barge-in, queue ordering, abort propagation — be tested
against scripted fakes instead of a real microphone. Those tests are in
[`packages/web/src/voice/__tests__/session.test.ts`](packages/web/src/voice/__tests__/session.test.ts)
and they are the tests I would point at first.

Per-turn latency is instrumented and surfaced in the UI, anchored to the moment
the learner *stopped speaking* rather than to mic-open — measuring from mic-open
makes a slow talker look like a slow system, and the number the learner feels is
the silence after they finish.

## Pedagogical calibration

Every prompt the product sends is built by one pure function,
[`compileInterviewerPrompt`](packages/shared/src/prompt.ts), from structured
inputs: a scenario and a learner state. There is no free-text prompt assembly at
any call site.

That constraint buys three things:

1. **The eval harness imports the same function.** If evals built their own
   prompts they would be scoring a prompt that never ships, which is the most
   common way an eval suite quietly becomes decorative.
2. **Compilation is deterministic**, so a scored regression bisects to a
   `PROMPT_VERSION` bump instead of being guessed at.
3. **The pedagogy is reviewable.** The CEFR register table, the seniority bar,
   the focus-selection rule and the "re-raise at most one past weakness" rule
   are all readable in one file, which means a pedagogy lead can argue with them
   without reading TypeScript.

Focus selection is weakest-first among the scenario's target competencies, with
one deliberate exception: a competency never observed outranks one that is
merely scoring badly. Gathering a first signal beats grinding on the thing
already known to be weak.

## Grounding

The interviewer can draw on what it was actually told: the scenario's own notes,
and a CV or job description the learner pastes in. Retrieval picks the passages
relevant to the question being worked toward and the answer just given, and the
prompt compiler renders them.

**The retriever is lexical and runs on the device.** Not because BM25 beats
embeddings — it does not — but because this is a claim about the *default*. The
document being searched is somebody's CV, so shipping it to a hosted vector
database to search forty chunks would trade the premise for an index that fits in
memory. And the eval gate compares scored runs against a baseline, so retrieval
has to be reproducible: floating-point embedding output is not bit-identical
across runtimes, which would make retrieval a source of variance in the one place
that exists to detect variance. `Retriever` is a narrow async interface so an
all-MiniLM implementation drops in behind it later. The reasoning is in
[ADR 0007](docs/adr/0007-lexical-retrieval-first.md).

Two details that turned out to matter more than the ranking function:

**A relevance floor.** A lexical retriever always returns its best match, however
bad. Without one, a pasted restaurant menu produces a "grounding" passage and the
interviewer asks the candidate about the soup. There is a test for exactly that.

**Retrieval is upstream of compilation.** `compileInterviewerPrompt` stays a pure
function — the orchestrator retrieves and passes passages in as data. Called
without them it produces a byte-identical prompt to the one it produced before
grounding existed, and a snapshot test captured at the old version holds it to
that.

The known limitation is recorded rather than papered over: lexical retrieval
cannot connect "MySQL" to "Postgres", because they share no tokens. That is the
gap an embedding retriever would close, and one of the adversarial cases exists
to document it.

**Where the document goes.** Nowhere. `saveLearnerState` drops the field and
`firestore.rules` rejects a learner write that carries it, so the claim holds at
the security boundary rather than by client politeness — and the silent-catch
sync path means trusting the client here would have failed invisibly. The
server-side scorer never receives it and does not need it.

## Model portability

Every language model — on-device or hosted — implements one interface. A pure
policy function picks between them:

```ts
selectModel(catalogue, policy, environment) -> { selected, rejected[] }
```

Hard constraints filter (residency, WebGPU availability, offline, a latency
budget); survivors sort by policy preference. The function returns *why each
candidate was rejected*, and the UI shows it, because "why am I on the slow
model" is the first question a portable stack generates and the router already
knows the answer.

Residency is a first-class constraint rather than a comment, because it is the
axis that actually decides deployments in this sector:

| Model | Residency | Offline |
|---|---|---|
| SmolLM2 1.7B (transformers.js / ONNX) | on device | yes |
| Azure OpenAI (Canada Central) | Canadian region | no |
| Google Gemini Flash | US region | no |

Cloud calls go through one Cloud Function rather than from the browser: keys
never reach the client, swapping vendors is a server deploy rather than an app
release, and every cloud inference writes one audit line saying where it went.
That log is the artefact a residency review actually asks for.

### Three deployment postures

The cloud route exists in the source, and whether it is *switched on* is a
property of a deployment rather than of the code. There are three sensible
answers and they are not the same answer:

| Posture | Cloud route | Whose bill |
|---|---|---|
| **Public demo / open-source default** | **Off** | Nobody's — there is nothing to spend |
| Self-hosted | On, if the operator wants it | The operator's own key |
| Portal / enterprise | On, through the proxy, with the audit log | The operator's, per contract |

The default is off, and that is a real switch rather than an absence. Enabling it
takes `CLOUD_INFERENCE_ENABLED=true` on the server *and* `VITE_CLOUD_ENABLED=true`
in the build — two deliberate acts, on both sides, neither trusted to be the only
one. **A vendor key being present is explicitly not consent**: a key can arrive in
an environment for a dozen innocent reasons and none of them should quietly turn a
public endpoint into a billable LLM API. There is a test that puts a real-looking
key in the environment and asserts the endpoint still refuses.

This is also why the setup screen no longer offers a cloud toggle it cannot
honour. It previously offered one unconditionally, so on a deployment with no key
a visitor could opt in, start a session and receive a 503 — an option that looked
like a feature and behaved like a bug.

**When the route is on, spend is bounded, and the reasoning is worth stating.** Anonymous
auth is deliberate — the product does not require an identity to practise — so a
Firebase ID token proves a browser loaded the page and nothing more. Anyone can
mint uids for free, in a loop, which means a per-user cap on its own bounds
nothing at all. So there are two ceilings, both counted *before* the vendor is
touched and before the model id is even resolved, and **the global one is the
one that actually bounds the bill**. Defaults are small on purpose (50 turns per
uid, 500 per deployment, per UTC day), and **size is capped as well as count** —
24,000 characters of message content per request, roughly 6,000 tokens. That
second cap is what makes the first one mean anything in dollars: the per-message
limits alone allowed 60 x 8,000 characters in one call, so a ceiling of 500 turns
a day was really a ceiling of 60 million input tokens a day. Capped both ways the
worst case is about **$0.75 a day** at Gemini 3 Flash's $0.25/M, which is the
pocket money the ceiling was supposed to describe.
The check fails closed — a counter that cannot be read cannot honour a ceiling,
and an unavailable opt-in feature with an on-device alternative one click away
beats an unbounded invoice. A GCP billing budget in `infra/` alerts at 50/90/100%
as a backstop for the case where that code is wrong.

Adding a vendor is a descriptor plus an adapter. Nothing in the orchestrator
changes.

## Evaluation harness

`evals/` is a real harness, not a folder with some prompts in it.

**Cases are situations, not expected answers.** There is no single correct
interviewer turn, so cases assert the *properties* a good turn must have.
Golden-output tests on generative systems fail on paraphrase and pass on
nonsense.

**Two scoring layers, strictly divided.**

*Deterministic checks* (`evals/src/checks.ts`) run on every turn and cost
nothing: markdown or emoji in something about to be read aloud, three stacked
questions, a turn too long to listen to, phrases that give the answer away
(`"a strong answer would..."`), breaking character, grading the candidate
mid-interview, or answering a French scenario in English. Anything decidable by
a rule lives here. Every check has tests proving it fires — a check that can
never fail is worse than no check.

*An LLM judge* (`evals/src/judge.ts`) scores the nine-dimension rubric in
[`packages/shared/src/rubric.ts`](packages/shared/src/rubric.ts), which is
reserved for genuine judgement: was the difficulty right, was that the follow-up
the answer deserved.

The judge is built to be distrusted. It runs at temperature 0, it is shown the
interviewer's own system prompt so it scores against the stated bar rather than
its own taste, and **every score must quote the turn — quotes are verified
against the text and unverifiable ones are discarded.** If most of a verdict is
discarded the judge is retried, and if retries run out the case errors rather
than scoring zero. (Returning an empty verdict there scores the case 0, which
looks exactly like a catastrophic quality regression and sends someone off to
bisect a prompt that was fine. That bug existed and a test caught it.)

**Test sets** are three JSONL files. Core behaviour; a grounding set; and an
adversarial set that is the most interesting of the three — a learner asking what
a good answer would be, a prompt injection, a request to be scored mid-interview,
an invitation to ask about family status, an off-topic derail, and a *legitimate*
clarifying question that must not be treated as evasion.

The grounding cases carry the document the interviewer was given, so the harness
retrieves from the same corpus the app would. Two of them did not test what they
claimed until a probe showed what the retriever was actually returning: the
contradiction case retrieved nothing at all, and the injection case never
surfaced the injection, so the model was never asked to resist anything. **An
adversarial case that cannot reach the model is decoration**, which is the same
lesson as the checks that could never fire, arriving by a different route.

One dimension is scored conditionally. `grounding` is dropped from the rubric
entirely when the interviewer was given no context, rather than scored — asking a
judge how well a turn used context it never had produces a number that means
nothing, and that number would then drag the dimension mean under its gate floor
on every case with nothing to ground against. The judge also discards a score for
a dimension it was not shown.

**Quality gates** (`evals/src/gate.ts`) fail a build on: any critical-dimension
failure (answer leakage, safety) regardless of the average; a composite below
the floor; any single dimension below its floor; or a regression beyond
tolerance against a recorded baseline. Critical failures are absolute because
averaging a measured harm away across forty passing cases is how a product ships
one it already knew about.

**CI runs it on every pull request with no vendor credentials**, against stored
reference turns with deterministic checks only. The expensive half — live vendor
calls, rubric scoring — is a separate manually-triggered workflow. Gating every
commit on a paid non-deterministic judge trains people to ignore the gate.

```bash
pnpm eval                                   # offline, deterministic checks
pnpm --filter @greenroom/evals exec node --experimental-strip-types \
  src/cli.ts --backend=openrouter --judge=openrouter --gate
```

Backends: `replay` (default, no keys), `openrouter`, `azure`, `gemini`, and
`local` for the on-device model natively. `evals/baseline.json` is the recorded
reference the regression gate compares against — see the project-status section
for what that run actually found.

Full detail, including how to calibrate the judge against human raters, is in
[docs/EVALUATION.md](docs/EVALUATION.md).

## Agent skills

Three skills ship in [`.claude/skills`](.claude/skills), so an agent working in a
clone of this repo — or on somebody else's voice product entirely — starts with
the judgement this one paid for rather than rediscovering it.

| Skill | For |
|---|---|
| `voice-evals` | Writing held-out cases for a spoken agent, running them, reading the result |
| `voice-checks` | Deciding whether something is a rule or a judgement, and writing either |
| `voice-pipeline` | Building or debugging a cascade, and choosing between cascade and duplex |

They are written to be portable: the method first, this repo as the worked
example. What they encode is the expensive half — cases are situations rather
than expected answers; a check that cannot fail is worse than none; verify the
quote, not just that one was given; score only what the model was actually given;
anchor latency on speech-end rather than mic-open; a reasoning model shares its
token budget between thinking and answering.

**The skills are under test.** `packages/shared/src/__tests__/skills.test.ts`
holds them to the parts of themselves that are mechanically checkable — the
frontmatter, every file they cite, every check and rubric dimension they name,
and every `pnpm` script they tell someone to run. Prose an agent acts on is worse
when stale than when missing, and this repo does not get to exempt its own
documentation from the rule it applies to its checks.

## Infrastructure and deployment

The backend is a Firebase project, split between two tools by cadence:

**Terraform/OpenTofu (`infra/`)** owns the durable things — the project, billing
linkage, enabled APIs, the auth configuration, the web app registration, and the
Firestore database.

**Firebase CLI** owns the things that change with the code — Cloud Functions,
hosting bundles, and security rules.

The deciding argument for putting infrastructure in code here is one resource: a
**Firestore database's location is permanent**. This product's posture is that
anything not on the learner's device stays in Canada, and that claim is worth
more as a reviewable line in `infra/main.tf` than as a dropdown someone picked
once. `northamerica-northeast1` is Montreal.

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # org id + billing account
tofu init && tofu apply
tofu -chdir=infra output -raw web_env > ../packages/web/.env
```

Then, from the root:

```bash
firebase deploy --only firestore                 # rules and indexes
pnpm --filter @greenroom/functions build         # bundles, see below
firebase deploy --only functions
```

One wrinkle worth knowing about: `packages/functions` depends on
`@greenroom/shared` through pnpm's `workspace:*` protocol, which Firebase's
deploy-time `npm install` cannot resolve. The build bundles the shared package
in with esbuild and keeps `firebase-functions`, `firebase-admin` and `zod`
external, so the deployed `package.json` lists only dependencies npm can
actually install.

Full detail in [infra/README.md](infra/README.md); the reasoning is in
[ADR 0004](docs/adr/0004-terraform-for-infrastructure.md).

## Project status: what is verified and what is not

This is a portfolio build, and I would rather be precise about its edges than
have you find them.

**Measured on real hardware** (Apple M-series, Chrome, foreground tab, warm
cache), running the production adapters through `bench.html`:

| | Opening turn | Steady state |
|---|---|---|
| Speech recognition | 510 ms | 495 ms |
| First token | 1866 ms | **929 ms** |
| **First audio** | 1956 ms | **1197 ms** |
| Decode | 42 tok/s | 42 tok/s |

Reusing the attention cache between turns halves time-to-first-token, so an
ongoing conversation replies in about 1.2 s. Full detail and method in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).

**Verified — I ran this:**

- 357 unit tests across five packages, including the pipeline concurrency:
  barge-in aborts generation and stops audio, the echo guard rejects
  self-interruption inside the window, sentence chunks are spoken while the
  model is still generating, a truncated turn records what was *heard* rather
  than what was generated, and a synthesiser fault does not kill the speech
  queue.
- Every package typechecks under TypeScript strict mode with
  `noUncheckedIndexedAccess`.
- The web app builds. Lazy-loading the model adapters took the initial bundle
  from 9.5 MB to 862 KB; transformers.js, the ONNX runtime and Kokoro load
  only when a session actually starts.
- The eval harness runs end to end and produces a gated report.
- **The backend is deployed and responding.** `tofu apply` created the project,
  Firestore in Montreal with delete protection and point-in-time recovery,
  anonymous auth, the web app registration, and the Eventarc/Pub/Sub service
  agents and IAM. `tofu plan` is clean afterwards, so the configuration is
  genuinely idempotent rather than apply-once. The security rules compiled and
  released. Both Cloud Functions are `ACTIVE`, and the live `generate` endpoint
  returns `401 Sign in required` without a Firebase ID token and `405` on GET —
  which is the deployed code's own auth path answering, not platform IAM.
- **Hosting is live** at https://greenroom-ii.web.app, serving the app shell,
  with the SPA rewrite working, `/api/generate` correctly routed to the
  function, and — the one that silently breaks the CPU fallback path if it is
  wrong — `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless` present in production, matching
  the dev server.

- **The evaluation harness has scored a live model.** 21 cases, all 21
  rubric-scored by an LLM judge, no errors and no critical failures, composite
  **0.905** at prompt version `2026-09-06.2` against GLM 5.3 Flash. The run is
  committed as `evals/baseline.json`, so the regression gate now has something to
  compare against. It found three things a hand-authored suite could not: an
  intermittent empty turn caused by a reasoning model sharing `max_tokens`
  between deliberation and answer, a recall gap in a critical check that matched
  "tell me about" but not "tell me what you built", and a reproducible slip into
  assistant register ("Thanks for sharing that") that the prompt never actually
  forbade. All three are fixed.
- **The regression gate has run against the baseline.** A later run scored
  `composite +0.009 against baseline 0.905` — the comparison working, not a
  claim that it would.
- **That run also failed the gate, and the failures are the point.** At
  temperature 0.6 this model intermittently slips into assistant register
  ("feel free to ask questions too"), opens with a long self-introduction
  instead of a question, and answers a clarifying question without clearly
  handing the floor back. None of that is fixed by a prompt line — the prompt
  already forbids the first — so it stands as a vendor result: **GLM 5.3 Flash
  is not reliably in-register for this product without mitigation.** That is
  the kind of answer a benchmarking harness exists to produce, and it only
  exists because the gate is allowed to fail.
- **The two scoring layers caught different halves of one failure**, which is
  the clearest evidence the split is real rather than tidy. Handed the team's
  context, the model recited it back at the candidate in paraphrase. The
  deterministic `not_reciting_context` check correctly stayed quiet — the text
  was reworded, not copied — and the judge scored `grounding` 2 and quoted the
  offending sentence. A rule catches verbatim; judgement catches paraphrase.
- **Grounding is the weakest dimension, at 3.5 of 5** — the lowest of the nine
  and exactly on its own gate floor. The interviewer is handed retrieved context
  and often asks the question it would have asked without it. That is a real
  finding rather than a rounding error, and it is the one the harness existed to
  produce.

**Not verified — be appropriately sceptical:**

- **The duplex realtime path has never talked to a vendor.**
  `packages/shared/src/duplex.ts` defines the interface a realtime API would
  implement, and `realtime-session.ts` orchestrates against it — synthesising the
  `Turn[]` and `TurnTimings` the debrief and the mastery scorer require, leaving
  `sttMs` undefined because a duplex stream has no recognition boundary to
  measure, disabling the local VAD when the vendor handles barge-in itself, and
  refusing to start against a vendor that emits no assistant transcript. All of
  it has run only against a scripted fake in unit tests. There is no adapter for
  Gemini Live, Azure Realtime or OpenAI Realtime, no duplex credential exists
  here, and no audio has ever crossed that seam. It is a design verified as a
  design; treat any claim about realtime latency or barge-in quality as unmade.
- **The loop has never run against a real microphone.** Every measurement uses
  pre-recorded utterances. VAD initialisation is verified against a synthetic
  stream (`vadcheck.html`), but endpointing quality, echo cancellation and
  barge-in responsiveness with live speech are unmeasured — and barge-in on
  laptop speakers is where I would expect trouble first.
- **The latency and quality numbers in the model catalogue are seed values, not
  measurements.** Their *ordering* is grounded — model ids and VRAM figures are
  verified against WebLLM's own records by a test, and quality follows the
  published intelligence ranking within the Qwen3.5 family — but the absolute
  figures are assumptions. They encode the ordering the design assumes so that routing
  behaves sensibly before anyone has benchmarked anything. They are labelled as
  such in the source. [docs/BENCHMARKS.md](docs/BENCHMARKS.md) describes the
  measurement to run; no measured run is committed.
- **The `referenceTurn` values in the eval datasets are hand-authored
  exemplars, not captured model output.** They exist so the harness and gates
  can be run and reviewed offline with no vendor account, and they are
  deliberately still exemplars: replay serves a stored turn, so replaying
  recorded output cannot catch a model regression however realistic the turns
  are — it is deterministic by construction. The committed baseline is what
  detects a model regression, and a live run is what exercises it.
- **No full session has been run against the live backend.** The endpoints
  answer correctly, but nobody has signed in anonymously, completed an
  interview, written a session document and watched `onSessionCreated` fold the
  scores into their mastery estimates. The scoring trigger also needs
  `AZURE_OPENAI_*` or `GOOGLE_API_KEY` configured before it does anything but
  log that it skipped.
- **The judge has not been calibrated against human raters.** One live run
  exists and a baseline is committed, but a judge nobody has checked against a
  person is an opinion with a number attached. The procedure is written up in
  [docs/EVALUATION.md](docs/EVALUATION.md) precisely because it is the step that
  decides whether these numbers mean anything. Worth knowing too: this run used
  the same model as judge and as subject, which is the cheapest possible setup
  and the one most likely to flatter itself.
- VAD thresholds and the barge-in guard window are reasoned starting points that
  want tuning against recorded learner audio.

## Repository map

```
packages/shared/src
  domain.ts       learner state, competencies, sessions, mastery updates
  prompt.ts       the prompt compiler — the pedagogical layer
  retrieval.ts    corpus assembly and the lexical retriever
  rubric.ts       nine scoring dimensions with anchors, and the judge prompt
  pipeline.ts     stage interfaces, latency budget, sentence chunking
  routing.ts      model descriptors and the routing policy function
  scenarios.ts    the content the app, the scorer and the harness all share

packages/web/src
  voice/session.ts       the orchestrator: cascade, barge-in, instrumentation
  voice/vad.ts           Silero VAD, echo-cancelled capture
  voice/pipeline-worker.ts main-thread handle to the three on-device stages
  voice/inference.worker.ts Whisper, the interviewer model and Kokoro, off-thread
  voice/model-manifest.ts stage declarations — repo, modules, dtype per device
  voice/models.ts        the model catalogue the router chooses from
  voice/local-models.ts  loading a folder of models already on disk
  voice/llm-cloud.ts     SSE client for the cloud route
  voice/realtime-session.ts the duplex orchestrator — no vendor adapter yet
  state/, components/    React layer

packages/functions/src
  generate.ts     SSE cloud-inference proxy, auth, caps, audit logging
  scoring.ts      server-authoritative answer scoring and mastery folding
  providers/      Azure OpenAI and Gemini adapters

evals
  src/checks.ts   deterministic checks
  src/judge.ts    LLM judge with verified evidence quotes
  src/gate.ts     quality gates
  datasets/       core, adversarial and grounding test sets
  baseline.json   the recorded reference run the regression gate compares against
```

## Licence

MIT, and the stack is permissively licensed throughout — Apache-2.0, MIT or ISC
for every dependency and every model, with one exception: **Llama 3.2 is
source-available under Meta's community licence, not OSI open source.** It is
offered as one model tier among four; every other tier is Apache-2.0, so
removing it makes the stack cleanly open source at the cost of one option.

Full audit, and what the Meta licence actually obliges, in
[docs/LICENSES.md](docs/LICENSES.md).
