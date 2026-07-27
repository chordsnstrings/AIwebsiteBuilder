# ADW infrastructure skeleton. Providers resolve their credentials from the
# environment / secrets manager — never hardcoded. Apply per vendor as each
# credential is deposited (see ../DEPLOYMENT.md). Not applied in demo mode.

terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  # backend "s3" { }  # configure remote state before first apply
}

variable "brand_domain" {
  type    = string
  default = "adw.example"
}

variable "cdn_domain" {
  type    = string
  default = "cdn.adwsites.com"
}

# --- Cloudflare: customer site hosting, DNS, R2 --------------------------------
# resource "cloudflare_pages_project" "customer_sites" { ... }
# resource "cloudflare_r2_bucket" "artefacts" { name = "adw-artefacts" }
# resource "cloudflare_r2_bucket" "provenance" { name = "adw-provenance" }  # immutable, 7-year retention

# --- AWS: SES transactional rail (brand domain only) --------------------------
# resource "aws_ses_domain_identity" "brand" { domain = var.brand_domain }
# resource "aws_ses_domain_dkim" "brand" { domain = aws_ses_domain_identity.brand.domain }
# resource "aws_sns_topic" "bounces" { name = "adw-ses-bounces" }
# resource "aws_sns_topic" "complaints" { name = "adw-ses-complaints" }

# --- Postgres (Neon/RDS): consent ledger with RPO 0 ---------------------------
# The consent ledger requires synchronous replication. Roles and the append-only
# triggers are created by packages/db migrations, not here.

output "notes" {
  value = "Apply per vendor as credentials are deposited. Consent ledger requires synchronous replication (RPO 0)."
}
