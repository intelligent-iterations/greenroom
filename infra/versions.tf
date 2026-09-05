terraform {
  required_version = ">= 1.6"

  required_providers {
    # Several Firebase resources (google_firebase_project, google_firebase_web_app,
    # google_identity_platform_config) exist only in the beta provider. Both are
    # declared and each resource uses the narrower one it needs, rather than
    # putting everything on beta by default.
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }
}

# Two provider configurations, which the Firebase resources genuinely require.
#
# `user_project_override` attributes API quota to the project being managed. That
# is what the Firebase APIs want — but it cannot be used while creating the
# project itself, because the provider would send a project id that does not
# exist yet as the quota project and the call fails before creation.
#
# So: the `no_user_project_override` alias creates the project and enables its
# APIs. Everything after that — including attaching Firebase, which refuses calls
# without a quota project — uses the default configuration with the override on.
# This split is Google's documented pattern for Firebase under Terraform, not a
# workaround.
provider "google" {
  alias                 = "no_user_project_override"
  user_project_override = false
}

provider "google-beta" {
  alias                 = "no_user_project_override"
  user_project_override = false
}

provider "google" {
  billing_project       = var.project_id
  user_project_override = true
}

provider "google-beta" {
  billing_project       = var.project_id
  user_project_override = true
}
