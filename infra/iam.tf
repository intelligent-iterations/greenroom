# Service agents and IAM for 2nd-gen Cloud Functions.
#
# A first 2nd-gen deploy on a fresh project reliably fails with "Permission
# denied while using the Eventarc Service Agent", and the advice is to wait a
# few minutes and retry. That works, but "retry until it stops failing" is not a
# reproducible environment: the identities below are created lazily by Google on
# first use, so declaring them makes the ordering explicit and the failure go
# away for the next person who runs `tofu apply` from scratch.

# Service agents are created on demand. Forcing creation here means the IAM
# bindings below have something to bind to.
resource "google_project_service_identity" "eventarc" {
  provider = google-beta
  project  = google_project.greenroom.project_id
  service  = "eventarc.googleapis.com"

  depends_on = [google_project_service.services]
}

resource "google_project_service_identity" "pubsub" {
  provider = google-beta
  project  = google_project.greenroom.project_id
  service  = "pubsub.googleapis.com"

  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "eventarc_agent" {
  project = google_project.greenroom.project_id
  role    = "roles/eventarc.serviceAgent"
  member  = "serviceAccount:${google_project_service_identity.eventarc.email}"
}

# Pub/Sub mints OIDC tokens to authenticate Eventarc's push into Cloud Run.
# Without this the Firestore trigger deploys and then silently fails to deliver.
resource "google_project_iam_member" "pubsub_token_creator" {
  project = google_project.greenroom.project_id
  role    = "roles/iam.serviceAccountTokenCreator"
  member  = "serviceAccount:${google_project_service_identity.pubsub.email}"
}

data "google_compute_default_service_account" "default" {
  project    = google_project.greenroom.project_id
  depends_on = [google_project_service.services]
}

# The runtime service account for 2nd-gen functions. It needs to receive
# Eventarc events, be invoked by them, and write build artifacts and logs.
resource "google_project_iam_member" "runtime" {
  for_each = toset([
    "roles/eventarc.eventReceiver",
    "roles/run.invoker",
    "roles/artifactregistry.writer",
    "roles/logging.logWriter",
    "roles/storage.objectViewer",
  ])

  project = google_project.greenroom.project_id
  role    = each.value
  member  = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}
