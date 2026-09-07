# Greenroom infrastructure.
#
# Scope: the durable, hard-to-change things — the project, its billing link,
# enabled APIs, the Firestore database and its permanent location, auth
# configuration, and the registered web app.
#
# Deliberately NOT here: Cloud Functions source, hosting bundles, and Firestore
# security rules. Those are application artifacts that change on the same cadence
# as the code, and `firebase deploy` already does them well. Expressing them in
# Terraform would mean hand-rolling GCS source objects and would leave two tools
# owning one resource, which is worse than either owning it alone.
# See docs/adr/0004-terraform-for-infrastructure.md.

resource "google_project" "greenroom" {
  provider        = google.no_user_project_override
  name            = var.project_name
  project_id      = var.project_id
  org_id          = var.org_id
  billing_account = var.billing_account

  # Firebase attaches labels and services to the project out of band; without
  # this, every plan after `projects:addfirebase` shows spurious drift.
  lifecycle {
    ignore_changes = [labels]
  }
}

# APIs, enabled explicitly so a fresh clone reaches a working project without
# anyone chasing a "has not been used before or it is disabled" error.
resource "google_project_service" "services" {
  provider = google.no_user_project_override

  for_each = toset([
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "firebase.googleapis.com",
    "firestore.googleapis.com",
    "firebaserules.googleapis.com",
    "identitytoolkit.googleapis.com",
    "cloudfunctions.googleapis.com",
    # 2nd-gen functions run on Cloud Run and use the default compute service
    # account as their runtime identity, so this is required even though nothing
    # here ever creates a VM.
    "compute.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "eventarc.googleapis.com",
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "storage.googleapis.com",
  ])

  project = google_project.greenroom.project_id
  service = each.value

  # Leave APIs enabled on destroy. Disabling them tears down dependent
  # resources in an order Terraform does not control, and the failure mode is
  # a half-destroyed project.
  disable_on_destroy = false
}

# Uses the override provider, unlike the resources above it: firebase.googleapis.com
# refuses calls without a quota project, and by this point the project exists to
# be one. Only google_project itself genuinely cannot use the override.
resource "google_firebase_project" "greenroom" {
  provider = google-beta
  project  = google_project.greenroom.project_id

  depends_on = [google_project_service.services]
}

# The residency decision, in one resource. `location_id` is permanent.
resource "google_firestore_database" "default" {
  provider    = google-beta
  project     = google_project.greenroom.project_id
  name        = "(default)"
  location_id = var.location
  type        = "FIRESTORE_NATIVE"

  # Transcripts are the record a learner's mastery estimates are derived from.
  # Point-in-time recovery is cheap insurance against a bad migration.
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"

  depends_on = [google_firebase_project.greenroom]
}

# Anonymous sign-in.
#
# The product deliberately does not require an identity to practise a job
# interview — that is a barrier with no justification — but it does need a token
# so requests are attributable for rate limiting and the cloud-inference audit
# log. Anonymous auth is exactly that trade.
resource "google_identity_platform_config" "auth" {
  provider = google-beta
  project  = google_project.greenroom.project_id

  sign_in {
    anonymous {
      enabled = true
    }

    # Declared explicitly rather than omitted. Two reasons: the API returns
    # these blocks with defaults whether or not they are configured, so leaving
    # them out produces a permanent one-resource diff on every plan — and a
    # permanently dirty plan is how real drift gets ignored. And stating that
    # email and phone sign-in are OFF is worth more in a review than their
    # absence, which reads as an oversight.
    # Email/password sign-in. Enabled so a learner can keep their progress
    # across devices without a Google account, which matters in an
    # institutional setting where personal Google accounts are often blocked.
    email {
      enabled           = true
      password_required = true
    }

    phone_number {
      enabled            = false
      test_phone_numbers = {}
    }
  }

  multi_tenant {
    allow_tenants = false
  }

  # Anonymous accounts are upgraded in place when a learner signs in, so the
  # sessions they completed before signing up are not orphaned.
  authorized_domains = [
    "localhost",
    "${var.project_id}.firebaseapp.com",
    "${var.project_id}.web.app",
  ]

  depends_on = [google_project_service.services]
}

resource "google_firebase_web_app" "greenroom" {
  provider     = google-beta
  project      = google_project.greenroom.project_id
  display_name = "Greenroom web"

  # Keep the app registration if the config is torn down; deleting it would
  # invalidate the app id baked into any deployed build.
  deletion_policy = "ABANDON"

  depends_on = [google_firebase_project.greenroom]
}

data "google_firebase_web_app_config" "greenroom" {
  provider   = google-beta
  project    = google_project.greenroom.project_id
  web_app_id = google_firebase_web_app.greenroom.app_id
}

# A budget with alerts at 50/90/100% of the monthly ceiling.
#
# Deliberately belt and braces. The application quota in
# packages/functions/src/quota.ts bounds calls before they reach a vendor, and
# that is the control that should ever actually bind. This exists for the case
# that control is wrong — a bug, a bad env override, a path that forgets to
# check — because the failure mode there is financial and silent, and a bill is
# a bad way to find out.
#
# Note this ALERTS, it does not cap: Google has no hard spend cutoff, and a
# budget that silently stopped serving would be its own kind of outage. The
# hard ceiling is the one in the function.
resource "google_billing_budget" "greenroom" {
  billing_account = var.billing_account
  display_name    = "${var.project_name} monthly ceiling"

  budget_filter {
    projects = ["projects/${google_project.greenroom.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }
}
