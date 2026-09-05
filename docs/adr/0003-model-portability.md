# ADR 0003: Model portability through descriptors and a routing policy

**Status:** accepted
**Date:** 2026-09-05

## Context

The stack must be able to move between an on-device model, Azure OpenAI, Google
Gemini and specialist voice vendors, because the eventual deployment target is
Azure-centric while the product premise is on-device, and because vendor
selection in this sector is decided as much by procurement and residency as by
quality.

"Portable" is easy to claim and usually means an interface that has only ever
had one implementation.

## Decision

Two mechanisms, both small:

1. **One interface per stage** (`LanguageModel`, `SpeechRecognizer`,
   `SpeechSynthesizer`) in `packages/shared/src/pipeline.ts`. The orchestrator
   depends on nothing else.
2. **A model catalogue of descriptors and one pure routing function.** Each
   backend publishes a `ModelDescriptor` — residency, first-token latency,
   quality, cost, offline capability, WebGPU requirement. `selectModel(catalogue,
   policy, environment)` filters on hard constraints and sorts survivors by
   policy preference.

Cloud vendors sit behind a single Cloud Function rather than in the browser.

## Rationale

**Residency is a hard constraint, not a preference.** It is the axis that
decides deployments here, so it is a filter in the routing function rather than
a comment in a config file. The default policy admits `device` only.

**The router explains itself.** `selectModel` returns why each candidate was
rejected, and the UI shows it. "Why am I on the slow model" is the first
question a portable stack generates in production, and the router already knows
the answer — logging it instead of showing it just moves the question to
someone else.

**Purity.** The routing function has no I/O, so its decisions are asserted in
tests and replayable in the eval harness. Routing logic that can only be
observed in production is not reviewable.

**Keys stay server-side.** Vendors are reached through one Cloud Function
because: keys never touch the client; swapping Azure for Gemini becomes a server
deploy rather than an app release, which matters when the app is embedded in a
portal on someone else's release train; and every cloud inference writes one
audit line naming the vendor and residency. That log is what a residency review
actually asks for.

**Portability is only real if exercised.** Two hosted providers are implemented,
not one plus a plan, and the live eval workflow runs the same test set through
each so the comparison is on identical inputs with a fixed judge.

## Consequences

- Adding a vendor is a descriptor plus an adapter plus a server-side id mapping.
  Nothing in the orchestrator changes.
- The descriptor's latency and quality fields are only as good as the
  measurement behind them. They currently hold seed values, labelled as such —
  see `docs/BENCHMARKS.md`. A router driven by numbers nobody measured is a
  router making up its mind, and that is a live risk in this repository today.
- The `Vendor` union deliberately lists only vendors with a working adapter.
  Adding a name without an adapter would let the router select a model nothing
  can serve.
