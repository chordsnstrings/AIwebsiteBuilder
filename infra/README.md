# ADW Infrastructure (Terraform)

Infrastructure-as-code across Cloudflare, AWS, Neon and ClickHouse, and the
disaster-recovery rebuild path (spec §9 vendor register, §44 DR). These are
skeletons — written, not applied. Apply them once the corresponding vendor
credentials are deposited (see `../DEPLOYMENT.md`).

- `main.tf` — provider blocks and the module layout.
- Cloudflare: zones, Pages projects, Workers routes, R2 buckets, scoped tokens.
- AWS: SES domain + DKIM verification, SNS bounce/complaint topics, scoped IAM.
- Neon: Postgres project with synchronous replication for the consent ledger
  (RPO 0), least-privilege roles.
- ClickHouse: event store with 25-month retention.

The Terraform state is itself the DR rebuild path: `terraform apply` from a
clean account, rotate all credentials, and redeploy customer sites from their
content-addressed R2 artefacts.
