# Infrastructure

Terraform (or OpenTofu — the configuration is standard HCL and works with
either) for the durable half of the Firebase project. What is here and what is
deliberately not is argued in
[ADR 0004](../docs/adr/0004-terraform-for-infrastructure.md).

## What this creates

| Resource | Why it is here |
|---|---|
| `google_project` | with billing linked, because Functions v2 needs Blaze |
| `google_project_service` × 13 | so a fresh clone reaches a working project without chasing "API not enabled" errors |
| `google_firebase_project` | attaches Firebase to the GCP project |
| `google_firestore_database` | **location is permanent** — this is the residency decision |
| `google_identity_platform_config` | anonymous sign-in |
| `google_firebase_web_app` | app registration, and the source of the web SDK config |

## First run

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # then fill it in
tofu init
tofu plan
tofu apply
```

Values for `terraform.tfvars`:

```bash
gcloud organizations list       # -> org_id
gcloud billing accounts list    # -> billing_account
```

Credentials: the providers use Application Default Credentials.

```bash
gcloud auth application-default login
```

If you would rather not set ADC, an access token works for a single run:

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)
```

## Then wire up the app

```bash
tofu -chdir=infra output -raw web_env > ../packages/web/.env
```

The web SDK values are **not secrets** — they ship inside the JavaScript bundle
of every Firebase web app. Access is governed by `firestore.rules` and by ID
token verification in the functions. `.env` is gitignored for hygiene, not
because leaking it would matter.

## Then deploy the application

From the repository root:

```bash
firebase deploy --only firestore   # security rules and indexes
pnpm --filter @greenroom/functions build
firebase deploy --only functions
pnpm --filter @greenroom/web build
firebase deploy --only hosting
```

Note the functions build step. `packages/functions` depends on
`@greenroom/shared` with pnpm's `workspace:*` protocol, which Firebase's
deploy-time `npm install` cannot resolve. The build bundles the shared package
into `dist/index.js` with esbuild and keeps `firebase-functions`,
`firebase-admin` and `zod` external, so the deployed `package.json` lists only
dependencies npm can actually install. `@greenroom/shared` sits in
`devDependencies` for the same reason — at deploy time it is a build input, not
a runtime dependency.

## State

State is local and gitignored, which is right for one operator. A second
operator needs a remote backend:

```hcl
terraform {
  backend "gcs" {
    bucket = "greenroom-tfstate"
    prefix = "infra"
  }
}
```

## Tearing down

`google_firestore_database` sets `delete_protection_state = "DELETE_PROTECTION_ENABLED"`
and `google_project_service` sets `disable_on_destroy = false`. Both are
deliberate: the first stops an accidental `destroy` from taking the learner
transcripts with it, and the second avoids a half-destroyed project caused by
APIs being disabled in an order Terraform does not control. A genuine teardown
means clearing delete protection first, or deleting the project outright.
