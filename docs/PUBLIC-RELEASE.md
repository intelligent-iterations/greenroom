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
- [ ] **The `generate` endpoint.** It is public-invoker by necessity (a browser
      has no Google credentials) and gated by a Firebase ID token. Worth
      confirming: token verification cannot be bypassed, the request caps in
      `GenerateBody` are enforced, and an authenticated user cannot run up an
      unbounded vendor bill. There is currently **no per-user rate limit** —
      that is the gap most worth closing before this is public.
- [ ] **Local file handling.** `local-models.ts` reads a folder the user picks
      and serves it to the model loader. Confirm nothing outside the selection
      is reachable and that a malicious filename cannot escape the match.
- [ ] **CSV import.** `parseEvalCsv` takes an arbitrary file. It never
      evaluates content, but the results view renders model output, so confirm
      there is no path to injection through a case's text.

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
- [ ] Decide whether the public demo keeps the cloud inference route. It needs
      vendor keys, and a public origin with a working cloud route is a bill
      waiting to happen without the rate limit above.
