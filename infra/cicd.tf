# Deploy identity for GitHub Actions.
#
# A dedicated service account whose key lives in a GitHub secret. The account
# and its roles are declared here so the permissions are reviewable in a diff;
# the key itself is created out of band with gcloud and never enters Terraform
# state, because state stores values in plaintext and a deploy key sitting in a
# state file is a credential nobody remembers is there.

resource "google_service_account" "deployer" {
  project      = google_project.greenroom.project_id
  account_id   = "github-deployer"
  display_name = "GitHub Actions deployer"
  description  = "Least-privilege identity for manually triggered deploys from CI."
}

# Scoped to what a deploy actually does. Deliberately not roles/editor: a CI
# identity that can delete the Firestore database is a worse problem than a
# slightly longer list of roles.
resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/firebasehosting.admin",    # publish hosting releases
    "roles/cloudfunctions.developer", # deploy functions
    "roles/firebaserules.admin",      # publish firestore rules
    "roles/run.admin",                # 2nd-gen functions are Cloud Run services
    "roles/artifactregistry.writer",  # push function container images
    "roles/iam.serviceAccountUser",   # act as the functions runtime SA
    "roles/serviceusage.serviceUsageConsumer",
    "roles/firebase.admin",           # the Firebase CLI's own project checks
  ])

  project = google_project.greenroom.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

output "deployer_service_account" {
  description = "Create a key for this account and store it as the GCP_SA_KEY secret."
  value       = google_service_account.deployer.email
}
