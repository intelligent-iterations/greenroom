# Greenroom

**Voice-first interview rehearsal that runs on your device.**

Live: **https://greenroom-ii.web.app**

You talk. It listens, asks a real follow-up, and talks back — and on a machine
with WebGPU, none of your audio, your transcript or your answers leave the
browser. Speech recognition, the language model and the voice are all running
locally in the tab.

That is the whole idea. People rehearse job interviews because they are nervous
about them, and asking someone to upload their worst answers about their worst
professional decisions to a third party is a bad trade. Running on-device makes
the privacy question disappear rather than answering it in a policy page — and
as a side effect, a deployment with no data egress is a much shorter
conversation with anyone reviewing data residency.

---

## Contents

- [What it does](#what-it-does)
- [Run it](#run-it)
- [Architecture](#architecture)
- [The voice pipeline](#the-voice-pipeline)
- [Pedagogical calibration](#pedagogical-calibration)
- [Model portability](#model-portability)
- [Evaluation harness](#evaluation-harness)
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

**No WebGPU?** The app tells you so on the setup screen and explains what it
will do instead. Speech recognition falls back to multi-threaded WASM, the voice
falls back to the platform synthesiser, and the interviewer model needs either a
GPU or your explicit consent to use a cloud model — it will not quietly ship
your answers off-device.

Other useful commands:

```bash
pnpm test         # 103 unit tests across four packages
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

Four packages, one shared vocabulary:

| Package | What it is |
|---|---|
| `packages/shared` | Domain model, prompt compiler, rubric, routing policy. Imported by all three other packages **and by the eval harness**. |
| `packages/web` | React app and the voice pipeline. |
| `packages/functions` | Firebase Cloud Functions: the cloud-inference proxy and server-side scoring. |
| `evals` | Evaluation harness, test sets, quality gates. |

Firebase is entirely optional. With no config the app runs local-only: bundled
scenarios, learner state in `localStorage`, on-device inference, no network.

## The voice pipeline

Cascaded — speech recognition, then a language model, then speech synthesis —
rather than a native realtime API. The reasoning is in
[ADR 0002](docs/adr/0002-cascaded-vs-realtime.md); the short version is that no
realtime voice API runs on-device, so choosing one would mean giving up the
premise.

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
  all fifteen in a few seconds.

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

*An LLM judge* (`evals/src/judge.ts`) scores the eight-dimension rubric in
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

**Test sets** are two JSONL files: core behaviour, and an adversarial set that
is the more interesting half — a learner asking what a good answer would be, a
prompt injection, a request to be scored mid-interview, an invitation to ask
about family status, an off-topic derail, and a *legitimate* clarifying question
that must not be treated as evasion.

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
  src/cli.ts --backend=azure --judge=gemini --gate
```

Full detail, including how to calibrate the judge against human raters, is in
[docs/EVALUATION.md](docs/EVALUATION.md).

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

- 103 unit tests across four packages, including the pipeline concurrency:
  barge-in aborts generation and stops audio, the echo guard rejects
  self-interruption inside the window, sentence chunks are spoken while the
  model is still generating, a truncated turn records what was *heard* rather
  than what was generated, and a synthesiser fault does not kill the speech
  queue.
- Every package typechecks under TypeScript strict mode with
  `noUncheckedIndexedAccess`.
- The web app builds. Lazy-loading the model adapters took the initial bundle
  from 9.5 MB to 819 KB; Whisper, WebLLM and Kokoro load only when a session
  actually starts.
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

**Not verified — be appropriately sceptical:**

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
  can be run and reviewed offline with no vendor account. `--record` against a
  live backend replaces them, and only then does the suite catch model
  regressions rather than just prompt and check regressions.
- **No full session has been run against the live backend.** The endpoints
  answer correctly, but nobody has signed in anonymously, completed an
  interview, written a session document and watched `onSessionCreated` fold the
  scores into their mastery estimates. The scoring trigger also needs
  `AZURE_OPENAI_*` or `GOOGLE_API_KEY` configured before it does anything but
  log that it skipped.
- **No live evaluation run.** The gate has only ever run offline against
  hand-authored reference turns. No baseline exists, and the judge has not been
  calibrated against human raters — the procedure for that is written up in
  docs/EVALUATION.md precisely because it is the step that decides whether any
  of these numbers mean anything.
- VAD thresholds and the barge-in guard window are reasoned starting points that
  want tuning against recorded learner audio.

## Repository map

```
packages/shared/src
  domain.ts       learner state, competencies, sessions, mastery updates
  prompt.ts       the prompt compiler — the pedagogical layer
  rubric.ts       eight scoring dimensions with anchors, and the judge prompt
  pipeline.ts     stage interfaces, latency budget, sentence chunking
  routing.ts      model descriptors and the routing policy function
  scenarios.ts    the content the app, the scorer and the harness all share

packages/web/src
  voice/session.ts       the orchestrator: cascade, barge-in, instrumentation
  voice/vad.ts           Silero VAD, echo-cancelled capture
  voice/stt-whisper.ts   Whisper via transformers.js (WebGPU → WASM)
  voice/llm-webllm.ts    on-device LLM via WebLLM
  voice/llm-cloud.ts     SSE client for the cloud route
  voice/tts-kokoro.ts    Kokoro neural voice
  voice/tts-webspeech.ts platform voice fallback
  state/, components/    React layer

packages/functions/src
  generate.ts     SSE cloud-inference proxy, auth, caps, audit logging
  scoring.ts      server-authoritative answer scoring and mastery folding
  providers/      Azure OpenAI and Gemini adapters

evals
  src/checks.ts   deterministic checks
  src/judge.ts    LLM judge with verified evidence quotes
  src/gate.ts     quality gates
  datasets/       core and adversarial test sets
```

## Licence

MIT, and the stack is permissively licensed throughout — Apache-2.0, MIT or ISC
for every dependency and every model, with one exception: **Llama 3.2 is
source-available under Meta's community licence, not OSI open source.** It is
offered as one model tier among four; every other tier is Apache-2.0, so
removing it makes the stack cleanly open source at the cost of one option.

Full audit, and what the Meta licence actually obliges, in
[docs/LICENSES.md](docs/LICENSES.md).
