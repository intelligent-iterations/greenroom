# Public release checklist

The repository is **private** and stays private until the items below are done.
This is the list, not a promise that it has been worked through.

## What is left

Two things block a public repository, and neither is security:

1. **Community files.** No `CONTRIBUTING.md`, `SECURITY.md` or issue templates.
   A repository asking for contributions with no way to report a vulnerability
   is a repository that will receive one by email at the worst possible moment.
2. **`.firebaserc` is tracked**, pointing every clone at `greenroom-ii`. It
   should be gitignored beside its `.example`, or a `firebase use` will target
   somebody else's project.

And one that blocks a public *deployment*: nothing from the generalisation work
has been pushed, so the live origin is an older build.

## Security review

### Re-verified 2026-09-08, against the current tree

The numbers below were first recorded before the generalisation work, which
added roughly twenty commits of new code — a quota module, a duplex seam, a
retriever, a readiness assessor. An inherited "0 findings" is not a result, so
the scanners were run again rather than trusted:

| Scan | Result |
|---|---|
| Semgrep (`p/default`, `typescript`, `react`, `secrets`, `owasp-top-ten`) | **0 findings**, 387 rules, 177 files |
| gitleaks, full history | **no leaks**, 43 commits, 1.14 MB scanned |
| `pnpm audit` | 8 advisories, **none reachable from shipped code** |

On the advisories: six are under `firebase-tools`, a devDependency used only at
deploy time. Two are high — `sharp` and `adm-zip` — and both arrive through
`@huggingface/transformers` in the **web and evals** workspaces, on Node paths
the browser never takes. The deployed function bundle was checked directly and
contains no transformers, no onnxruntime, no adm-zip and no sharp; its runtime
dependencies are `firebase-functions`, `firebase-admin` and `zod`, and nothing
else. (The one `sharp` string match in that bundle is the word "sharper" in a
rubric anchor.)

- [x] **Static analysis.** `.github/workflows/security.yml` runs CodeQL
      (`security-and-quality`), Semgrep (default, typescript, react, secrets,
      OWASP top ten), gitleaks over full history, and a dependency audit — on
      every push and PR, plus weekly, because advisories appear after code stops
      changing. Semgrep currently reports **0 findings**; the first run reported
      37 and what they were is recorded below.
- [x] **Dependency audit.** 7 advisories, none reachable from the shipped
      bundle: five are in `firebase-tools` (a devDependency used only at deploy
      time) and two — `sharp`, `adm-zip` — are on transformers.js's Node paths,
      with `sharp` appearing in the built worker as `sharp (ignored)`. The
      security workflow asserts that stays true rather than trusting today's
      analysis.
- [x] **Firestore rules.** 21 tests against the real emulator, blocking in CI.
      They cover the boundary that matters: a client cannot write `mastery`,
      `recentErrors` or `sessionsCompleted`, cannot smuggle one alongside a
      legitimate preference change, cannot read another learner's data, and
      cannot edit or delete a session transcript after the fact.

### What the first SAST run found

Worth recording, because "we ran a scanner" means little without it:

- **4 shell-injection findings.** Workflow inputs were interpolated directly
  into `run:` blocks. `confirm` is free text, so a crafted value could break out
  of the quoting and execute in a runner holding deploy credentials. All inputs
  now arrive through `env:`, where they are data rather than script.
- **27 mutable action tags.** Actions were pinned to `@v4`, which a compromised
  tag can repoint. Every action is now pinned to a commit SHA with the tag kept
  in a trailing comment.
- **3 pnpm supply-chain settings** absent — `minimumReleaseAge`,
  `blockExoticSubdeps`, `trustPolicy`. Now set; the tree includes WASM runtimes
  and native bindings, and a malicious version in it is the likeliest route to
  compromise.
- **1 prototype-pollution** risk copying parsed JSON with `Object.assign`.
- **2 format-string** issues in console logging.
- [x] **The `generate` endpoint.** Resolved rather than deferred, because
      "there is no key so it cannot spend" is an accident of configuration and
      not a control. The route is now off unless *both*
      `CLOUD_INFERENCE_ENABLED=true` on the server and `VITE_CLOUD_ENABLED=true`
      in the build say so — a key being present is explicitly not consent, and a
      test puts a real-looking key in the environment and asserts the endpoint
      still refuses before it verifies a token. When it is on: a global and a
      per-user daily ceiling counted before the vendor call and before the model
      id is resolved, request size capped at 24,000 characters as well as count,
      fail-closed counting, and a GCP billing budget as a backstop.
- [x] **Local file handling.** Nothing outside the selection is reachable, and
      the reason is structural rather than defensive: the app never touches a
      filesystem. `files` is the array the browser's own directory picker handed
      over, and every candidate is drawn from it, so the worst a crafted path
      achieves is matching a file the user already offered. Traversal strings are
      asserted inert in `local-models.test.ts`, and the cache never writes back —
      these are the user's files, lent for a session.
- [x] **CSV import.** No injection path. `parseEvalCsv` never evaluates content,
      and there is no `dangerouslySetInnerHTML`, `innerHTML` or
      `insertAdjacentHTML` anywhere in the web package — every piece of case text
      and model output reaches the DOM as a React text node.

## Do we meter tokens?

**On-device: no, and that is the point.** The tokens are generated on the
user's own GPU with the user's own electricity. There is no per-token cost, no
quota to enforce, no usage to account for, and nothing to rate limit. A user who
talks to it for eight hours costs the project exactly nothing. Metering local
inference would be inventing a problem — and worse, it would require reporting
usage back, which contradicts the reason the thing runs locally at all.

**The cloud route: yes**, because those tokens land on *our* vendor bill. That
is the only place the concern exists, and it is worth being precise that it is
about the endpoint, not about the product.

Which suggests the simplest resolution for a public release: **do not configure
vendor keys on the public deployment.** With no keys the endpoint returns 503
before reaching a vendor, so there is no bill to run up and no rate limit to
write. That is already the state today, so the exposure is theoretical rather
than live.

The cloud adapter still earns its place in the repository — it is the working
proof that the `LanguageModel` interface is genuinely portable, and it means an
operator who wants a stronger model can supply their own keys. It just does not
need to be switched on for a public demo of on-device inference.

- [x] **Decided: off, and off deliberately.** Leaving the keys unset was the
      right answer and the wrong mechanism — it makes safety depend on nobody
      setting one. The route now takes two explicit switches, and when a
      deployment does turn it on it is metered rather than trusted. See the
      endpoint item above and the "Three deployment postures" table in the
      README.

## Secrets and configuration

- [x] No secrets in the repository. `.env` is gitignored; `.env.example`
      documents the shape.
- [x] Firebase web config is public by design — access is governed by rules and
      token verification, not by hiding an API key.
- [x] Terraform state and `terraform.tfvars` are gitignored.
- [ ] Rotate the Firebase web app config if the project is ever pointed at real
      user data, since it will have been in a private repo's history.

## Content and licensing

- [x] Licences audited — see [LICENSES.md](LICENSES.md).
- [x] **Llama 3.2 removed.** Source-available, not open source, so it is gone
      rather than footnoted. Every remaining model is Apache-2.0 or MIT, and no
      weights are redistributed — the browser fetches them at runtime and the
      user can name any repository or use a local folder.
- [x] MIT licence file present.

## Honesty of the record

The README carries a "what is verified and what is not" section, and it should
survive contact with a public audience unchanged. Before release, confirm it is
still accurate — particularly that benchmark figures are labelled as
single-machine measurements and that the untested areas are still listed.

## Deployment

- [x] Instruments (`bench`, `evals` runner, probes) excluded from the
      production build; verified absent from the deployed origin.
- [x] Cross-origin isolation headers verified on the live site.
- [x] Cloud route on the public demo — off, by two switches rather than by
      omission.
- [ ] **Push and deploy.** Nothing from the generalisation work is live: the
      deployed origin is still an older build. Everything below is about a
      release that has not happened yet.
