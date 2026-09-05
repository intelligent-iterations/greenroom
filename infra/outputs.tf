output "project_id" {
  description = "Use this in .firebaserc."
  value       = google_project.greenroom.project_id
}

output "location" {
  description = "Firestore and Functions region."
  value       = google_firestore_database.default.location_id
}

# The web SDK config.
#
# Not marked sensitive, deliberately: these values ship inside the JavaScript
# bundle of every Firebase web app and are not secrets. Access is governed by
# firestore.rules and by ID token verification in the functions, not by keeping
# these hidden. Treating them as secret encourages the belief that leaking them
# matters, which distracts from the controls that actually do.
output "web_env" {
  description = "Contents for packages/web/.env"
  value       = <<-EOT
    VITE_FIREBASE_API_KEY=${data.google_firebase_web_app_config.greenroom.api_key}
    VITE_FIREBASE_AUTH_DOMAIN=${data.google_firebase_web_app_config.greenroom.auth_domain}
    VITE_FIREBASE_PROJECT_ID=${google_project.greenroom.project_id}
    VITE_FIREBASE_APP_ID=${google_firebase_web_app.greenroom.app_id}
    VITE_FUNCTIONS_REGION=${var.location}
  EOT
}
