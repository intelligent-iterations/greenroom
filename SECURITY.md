# Security

## Reporting a vulnerability

Please report privately rather than opening an issue: use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. A public issue is a disclosure, and the first people to read
it will not be the ones who can fix it.

Expect an acknowledgement within a week. This is a small project; it is not
staffed for a faster response and it would be dishonest to promise one.

## What is in scope

The parts of this project that could plausibly hurt someone:

- **`firestore.rules`** — the boundary between a client and the fields that
  decide what it is asked next. Anything that lets a client write `mastery`,
  `recentErrors` or `sessionsCompleted`, read another user's documents, or edit
  a session transcript after the fact.
- **`packages/functions/src/`** — the cloud inference proxy and the scoring
  trigger. Auth bypass, quota bypass, or anything that reaches a vendor without
  being counted.
- **Anything that gets a user's data off their own machine** unexpectedly. The
  product's central claim is that speech, transcripts and pasted documents stay
  on the device; a path that breaks it is a vulnerability even if nothing is
  technically exploitable.

## What is out of scope

- **Advisories in `firebase-tools`.** It is a devDependency used at deploy time
  and is not shipped. See `docs/PUBLIC-RELEASE.md` for the current audit.
- **Advisories on `@huggingface/transformers`' Node paths** (`sharp`,
  `adm-zip`). The browser never takes them and the deployed function bundle
  contains neither.
- **Model output itself.** A model that says something wrong, biased or
  unhelpful is a quality problem, and the evaluation harness in `evals/` is
  where that belongs. Report it as an issue, with a case.
- **Anything requiring a compromised machine already.** The app deliberately
  reads local model folders the user picks; that is the feature.

## How this project is scanned

CI runs on every push and pull request, plus weekly, because advisories appear
after code stops changing:

- **CodeQL** (`security-and-quality`)
- **Semgrep** — `p/default`, `p/typescript`, `p/react`, `p/secrets`,
  `p/owasp-top-ten`, failing the build on any finding
- **gitleaks** over full history, since history is what becomes public
- **Dependency audit**, asserting that known advisories stay unreachable from
  shipped code rather than trusting a one-time review

Every GitHub Action is pinned to a commit SHA. Workflow inputs reach scripts
through `env:` rather than `${{ }}` interpolation, because an input that lands
inside a `run:` block in a runner holding deploy credentials is a shell
injection with a very good blast radius.

`pnpm` is configured with `minimumReleaseAge`, `blockExoticSubdeps` and
`trustPolicy: no-downgrade` — the dependency tree includes WASM runtimes and
native bindings, and a malicious version in it is the likeliest route to
compromising this project.
