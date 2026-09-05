# ADR 0004: Terraform for infrastructure, Firebase CLI for deploys

**Status:** accepted
**Date:** 2026-09-05

## Context

The backend is a Firebase project: Firestore, anonymous auth, two Cloud
Functions, and static hosting. All of it can be created by clicking through the
Firebase console in about five minutes, and for a project this size that is a
legitimate option.

The question is whether infrastructure-as-code earns its cost here, or whether
it is résumé decoration on a small project.

## Decision

Split by cadence and by consequence:

**Terraform (`infra/`)** owns the project, its billing link, enabled APIs, the
Firestore database **and its location**, the auth provider configuration, and
the web app registration.

**Firebase CLI** owns Cloud Functions source, hosting bundles, and Firestore
security rules.

## Rationale

The deciding argument is not "infrastructure should be code". It is one specific
resource:

**A Firestore database's location is permanent.** It cannot be changed after
creation; moving region means a new database and a migration. This product's
stated posture is that anything not on the learner's device stays in Canada. If
that claim rests on someone having picked `northamerica-northeast1` from a
dropdown once, it is not reviewable, not reproducible, and not evidence of
anything. As a line in `infra/main.tf` it shows up in a diff, gets reviewed, and
can be pointed at during a residency conversation.

The same logic covers billing linkage and enabled APIs: they are set once,
forgotten, and painful to reconstruct from memory when the project has to be
rebuilt in a client's own GCP organisation — which, for this kind of engagement,
is the likely eventual ask.

The argument for keeping deploys out of Terraform is equally specific.
Terraform can deploy Cloud Functions v2, but doing it means hand-rolling a
source archive into GCS and reimplementing what `firebase deploy` already does,
including the emulator story and rules compilation. Two tools owning one
resource is worse than either owning it alone, and the tool that loses that
fight should be the one with the worse local development loop.

The dividing line is cadence. Infrastructure changes a handful of times in a
project's life. Application artifacts change several times a day. Tools that
suit one badly suit the other.

## Consequences

- A fresh environment is `tofu apply` plus `firebase deploy`, in that order.
  `infra/README.md` documents it.
- Provider configuration is more intricate than it looks. Firebase resources
  need `user_project_override` to attribute API quota, but the project cannot
  be *created* with that setting on, because the provider would send a project
  id that does not exist yet. Two provider configurations are declared, and the
  reason is commented where it lives, because this looks like noise until it
  bites.
- Terraform state is local and gitignored. For a single-operator portfolio
  project that is correct; anything with a second operator needs a GCS backend,
  and that is a one-block change.
- `google_firebase_project` and friends live in the `google-beta` provider. That
  is where Google ships them, and it is a known cost of managing Firebase this
  way.

## Alternatives rejected

**Everything in Terraform, including functions.** Rejected above: it duplicates
`firebase deploy` badly and degrades the development loop.

**Nothing in Terraform; console clicks documented in the README.** Rejected
because a README is not a reproducible environment, and because it would leave
the residency claim resting on an unverifiable manual step — the one thing here
most worth being able to prove.
