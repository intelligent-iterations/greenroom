# Public release checklist

The repository is **private** and stays private until the items below are done.
This is the list, not a promise that it has been worked through.

## Security review

Not yet performed. SAST is planned; this is what a reviewer should look at
first, written down now so it is not reconstructed later.

- [ ] **Static analysis** (SAST) across `packages/` and `evals/`.
- [ ] **Dependency audit** — `pnpm audit`, and a look at the transitive tree
      around `onnxruntime-web` and `@ricky0123/vad-web`, which ship WASM.
- [ ] **Firestore rules**, specifically that `mastery`, `recentErrors` and
      `sessionsCompleted` remain server-only. There are no tests for the rules
      themselves; the emulator supports them and they should exist.
- [ ] **The `generate` endpoint** — see "Do we meter tokens?" below, which
      reframes this. It is public-invoker by necessity (a browser has no Google
      credentials) and gated by a Firebase ID token. If the cloud route ships,
      confirm token verification cannot be bypassed, that the caps in
      `GenerateBody` hold, and add a per-user rate limit. If it does not ship,
      none of that applies.
- [ ] **Local file handling.** `local-models.ts` reads a folder the user picks
      and serves it to the model loader. Confirm nothing outside the selection
      is reachable and that a malicious filename cannot escape the match.
- [ ] **CSV import.** `parseEvalCsv` takes an arbitrary file. It never
      evaluates content, but the results view renders model output, so confirm
      there is no path to injection through a case's text.

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

- [ ] Decide: ship the cloud route publicly (then rate-limit it), or leave the
      keys unset (then it is inert). Do not ship it configured and unlimited.

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
- [ ] **Decide on Llama 3.2.** It is source-available, not open source. Either
      drop the tier (every other model is Apache-2.0, so the stack becomes
      cleanly open) or add the required "Built with Llama" attribution to the
      UI. Currently flagged in the picker and documented, not resolved.
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
- [ ] Cloud route on the public demo — decided under "Do we meter tokens?".
