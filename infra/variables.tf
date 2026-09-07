variable "project_id" {
  description = "GCP project id. Globally unique, permanent."
  type        = string
}

variable "project_name" {
  description = "Human-readable project name shown in the console."
  type        = string
  default     = "Greenroom"
}

variable "org_id" {
  description = "GCP organization id to create the project under."
  type        = string
}

variable "billing_account" {
  description = <<-EOT
    Billing account id to link.

    Required, not optional: Cloud Functions v2 needs the Blaze plan, and a
    project created without billing has to be reconfigured by hand later, which
    defeats the point of declaring it here.
  EOT
  type        = string
}

variable "location" {
  description = <<-EOT
    Region for Firestore and Cloud Functions.

    northamerica-northeast1 is Montreal. This is the single most consequential
    value in this file: a Firestore database's location is PERMANENT and cannot
    be changed after creation. Moving region means creating a new database and
    migrating.

    It is also the whole reason this project is in Terraform rather than clicked
    through a console. The product's residency posture is that anything not on
    the learner's device stays in Canada, and that claim should be a reviewable
    line in a diff, not a dropdown someone picked once.
  EOT
  type        = string
  default     = "northamerica-northeast1"
}

variable "monthly_budget_usd" {
  description = "Monthly spend ceiling for alerting. The last line of defence: the application-level quota in packages/functions/src/quota.ts is the one that should ever fire, and this is what catches the case where that code is wrong."
  type        = number
  default     = 25
}
