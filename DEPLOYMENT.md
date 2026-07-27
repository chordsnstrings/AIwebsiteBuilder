# ADW — Deployment & Go-Live Runbook

This system ships **keyless**. Every external vendor sits behind an adapter with
a mock implementation, selected automatically when no credential exists in the
vault. Nothing calls a real vendor until you deposit its credential through the
superadmin **Settings → Vault** surface. This document maps each vendor key to
its slot and to what flips live when you deposit it.

## 0. Run it now (demo mode, no keys)

```bash
pnpm install
pnpm vault:init          # writes a demo ADW_VAULT_MASTER_KEY to .env.local
pnpm db:start            # cold-starts the in-sandbox Postgres 16
pnpm demo                # migrate + seed + end-to-end pipeline + nightly evals
pnpm demo serve          # additionally serves the API + all four apps
pnpm verify              # typecheck + lint + full test suite
```

The apps run on: ops `:5173`, marketing `:5174`, preview `:5175`, dashboard `:5176`,
API `:8787`.

### Signing in to the operator console

`pnpm seed` creates the superadmin and prints a TOTP secret once:

```
superadmin: admin@adw.example
TOTP secret (enrol in your authenticator, then rotate the password): ...
```

Enrol that secret in an authenticator app, then use **Sign in** in the console
sidebar. TOTP is mandatory for the superadmin — a superadmin login cannot
complete without a valid code, and that is enforced in `login()` rather than by
convention. Until you sign in, the console renders against the seeded demo
fixtures; credentials deposited in demo mode are local to the browser session,
while deposits made while signed in go into the real vault.

## 1. The go-live model

The system is designed so that going live is a sequence of **credential deposits**,
not code changes. For each vendor:

1. A human creates the account and passes the vendor's KYB (the Vendor
   Orchestrator never creates accounts and never signs — spec §74).
2. The human deposits the credential in **ops → Settings → Vault** (write-only:
   after deposit only a fingerprint is shown; the secret is never retrievable).
3. The vendor's adapter flips from **mock** to **real** on the next call
   (`packages/vendors` resolves real vs mock by credential presence).
4. The Sentinel probe for that vendor must **pass** before the Orchestrator
   marks it `ACTIVE` — "the account exists" and "the integration works" are
   different claims (spec §75).

Compliance configuration (jurisdictions, thresholds, pricing, prohibited
categories) is **never** edited through any UI — those are pull requests to
`config/*.yaml`. The vault surface manages credentials, feature flags and kill
switches only.

## 2. Credential → vault slot map

| Vendor | Vault slot (`vendorId` / `keyName`) | What flips live | Env fallback |
|---|---|---|---|
| BytePlus ModelArk (primary rail) | `modelark` / `api_key` | Real LLM completions on the primary rail | `MODELARK_API_KEY`, `MODELARK_BASE_URL` |
| Google Gemini (fallback rail) | `google_ai` / `api_key` | Real fallback-rail completions | `GOOGLE_AI_API_KEY` |
| Anthropic (pinned CEO/Sentinel) | `anthropic` / `api_key` | Real control-plane completions | `ANTHROPIC_API_KEY` |
| Stripe | `stripe` / `secret_key` | Real card acquiring + subscriptions | `STRIPE_SECRET_KEY` |
| Stripe (webhooks) | `stripe` / `webhook_secret` | Signature-verified webhooks | `STRIPE_WEBHOOK_SECRET` |
| Cloudflare | `cloudflare` / `api_token` | Real Pages/DNS/R2 deploys | `CLOUDFLARE_API_TOKEN` |
| AWS SES | `aws_ses` / `access_key` (+ `secret_key`) | Real transactional email | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Google Workspace | `google_workspace` / `service_account` | Real cold mailbox provisioning | — |
| Microsoft 365 | `microsoft_365` / `client_secret` | Real second-provider mailboxes | — |
| Lead data (primary/secondary) | `lead_data_primary` / `api_key` | Real licensed record pulls | — |
| Email verification | `email_verification` / `api_key` | Real pre-send verification | — |
| Browserless | `browserless` / `api_key` | Real headless rendering/screenshots | — |
| Twilio | `twilio` / `auth_token` | SMS/voice (Phase 2, counsel-gated) | — |
| Langfuse | `langfuse` / `secret_key` | Real LLM tracing | — |
| Healthchecks.io | `healthchecks` / `ping_url` | Live dead-man's-switch heartbeat | — |
| Pushover | `pushover` / `token` | SEV1 push alerts | — |
| PagerDuty | `pagerduty` / `routing_key` | SEV1 phone escalation (never Twilio) | — |

## 3. Setup order (spec §13 — the sequence that avoids rework)

The five long-lead items gate the earliest Wave-1 send date (surfaced by the
Orchestrator). Start them first:

- **Week 1** — Corporations Canada (parent entity), Mercury/Wise (banking),
  GitHub + Terraform Cloud, Neon/Postgres, Cloudflare account. **Engage counsel
  now** (US/CA/UK/AU review — longest lead time).
- **Week 2** — AWS SES (verify brand domain, request production access early),
  Temporal Cloud, ClickHouse, Redis, Sentry; ModelArk + Google AI + Anthropic +
  Langfuse; Browserless.
- **Week 3** — **Domain registrar reseller** (needs approval), Cloudflare
  Registrar for burner domains (≤15/day), Google Workspace + M365 tenants (begin
  the 21-day warm-up immediately — hard floor), email verification + lead-data
  contracts, GlockApps, MXToolbox.
- **Week 4** — Stripe + Stripe Tax (secondary processor in parallel, not after),
  Stripe Connect application, Cloudflare Pages/Workers/R2, Google Business
  Profile API, insurance bound.

Longest lead times, start first: counsel review · registrar reseller approval ·
SES production access · mailbox warm-up (21 days, hard floor) · Stripe Connect
platform approval.

## 4. Production infrastructure

- **Database:** swap `DATABASE_URL` to your managed Postgres (Neon/RDS). The
  consent ledger requires synchronous replication (RPO 0). The migrations create
  the least-privilege `adw_app` role and the append-only triggers; run them
  against production with an admin role.
- **Vault master key:** in production, `ADW_VAULT_MASTER_KEY` comes from a real
  KMS/secrets manager, never a file. The `SecretsBackend` interface has
  compile-checked stubs for Infisical and AWS Secrets Manager — implement the
  `KeyWrapper` against your KMS and no ciphertext needs re-encrypting.
- **Workflow engine:** the in-house journaled-step engine runs against Postgres
  today. To move to Temporal Cloud, implement the `engine-temporal` adapter
  (the workflow *definitions* do not change) and point it at your namespace.
- **Events:** the Postgres `EventSink` is swappable for a ClickHouse sink (same
  envelope) by depositing the ClickHouse credential.
- **IaC:** `infra/` holds Terraform skeletons for Cloudflare, AWS, Neon and
  ClickHouse. **CI:** `.github/workflows/ci.yml` runs typecheck + lint + tests.

## 5. Pre-launch gate (Phase 0 exit criterion)

Before any autonomous outreach, all of these must hold (run `pnpm verify &&
pnpm demo` — they are machine-checked):

- Gate 19-case suite green; a cold send from the brand domain is refused.
- Reviewer rejects a deliberately broken build; a clean preview passes.
- Every role has a champion backed by a stored eval run; a grep for hardcoded
  model names in `packages/agents` returns nothing.
- Every T0 vendor has a live probe; the alert chain has been exercised; no
  CUST/PAY vendor is `ACTIVE` with an incomplete diligence file.
- One real preview generated end-to-end under $0.05 (the demo reports the cost).

## 6. Open items requiring counsel before Phase 1 (spec §19)

Photo-licensing position for speculative previews · `relates_to_role` template
wording · AI-disclosure timing · vendor data-licence terms (incl. screenshotting
the source page) · payments-licensing confirmation per market. These are tracked
but not resolvable in code.
