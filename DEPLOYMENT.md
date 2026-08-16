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

## 0.1 What the product is (v3.0)

Read this before the vendor tables, because it changes what "live" means.

v1 sold websites. The market was measured — 3,559 live businesses across eight
countries — and that thesis does not hold: **92–98% already have a website and
only 1.2% fail on mobile**. What almost nobody has is a business a machine can
read and transact with. 72.7% carry some JSON-LD, but only **9.6% publish
`Service` schema**, **24.7% publish a price**, and **11.6% clear both**.

So the product is the transaction layer: a knowledge base extracted from what
the business already published (with provenance per fact), a Q&A pack the owner
approves, and an agent that answers **only** from that pack and refuses outside
it. The website is included and never sold. Revenue is a **$399 agent setup and
activation fee** plus subscription — never a website fee. Pricing copy that says
otherwise is a bug.

The runtime consequence is one rule that everything else serves:

> ⛔ A stored answer is **returned**, never composed.

Grounding is a retrieval guarantee, not a prompt instruction. Under *Moffatt v.
Air Canada* (2024 BCCRT 149) the liability for what an agent says sits with the
business operating it — so `agent_turns.pair_id` and `agent_turns.retrieval_score`
are the customer's evidence, not our telemetry.

### The runtime surface

| Route | Auth | What it is |
|---|---|---|
| `POST /agent/session` | public | Opens a conversation against an **approved** pack |
| `POST /agent/turn` | public | One visitor message. Returns the answer; never the score or the pair id |
| `POST /api/enquiry` | public | The same widget with JavaScript disabled — returns HTML a browser renders |
| `GET /.well-known/mcp` | public | Manifest an AI assistant discovers. Advertises only what the vertical and a connected calendar allow |
| `POST /.well-known/mcp` | public | Tool call. **Same refusal decision a human gets** — one injected checker, both surfaces |
| `GET /agent/:customerId/gaps` | owner | Questions the agent could not answer, ranked by how often |
| `POST /agent/gaps/:id/approve` | owner | The **only** route by which a new answer enters a pack |

⛔ There is deliberately no auto-promotion of a fallback answer. A system that
promotes its own drafts is a system learning its own hallucinations, and by the
second round there is nothing left to check them against.

### The per-customer gate

`@adw/agenteval` builds **30 cases from the customer's own pack**: 20 it must
answer from what they published, 10 it must refuse. `pass_requires: all` — 29 of
30 does not ship, and the delivery email in `OnboardingWorkflow` is unreachable
except through a pass. A refusal probe is used only when it is provably outside
that pack; a gate that fires on correct behaviour gets overridden, at which
point it protects nothing.

### Retrieval, and where it will need to change

Retrieval is hybrid: cosine over 384-dim deterministic hashed n-gram embeddings,
BM25 (k1=1.2, b=0.75) over question + answer, fused by reciprocal rank fusion.
Fusion picks the candidate; the **cosine** is what the `config/playbooks.yaml`
thresholds gate (0.82 verbatim, 0.65 hedged), because an RRF score has no
absolute meaning. Then a coverage guard: every term in the question that narrows
it must appear in the pair.

That last gate is not optional polish. Measured against a real pack, *"are you
gas safe registered"* scores **0.759** against the pair *"Are you insured?"* —
over the 0.65 hedged floor. Both questions genuinely are about credentials, so
the embedding is right and the threshold is not enough; without coverage the
agent asserts a gas certification on the business's behalf.

**pgvector is not used.** It is not guaranteed present, and a pack is 150–250
pairs, which a brute-force scan handles exactly and in microseconds. The swap
points when a pack outgrows that are `EmbeddingProvider` (in
`packages/qapack/src/embedding.ts`) and `retrieve()` (in
`packages/concierge/src/retrieval/`). The interface does not change. Note that a
real embedding provider produces a **different vector space**: packs must be
re-embedded, and `qa_packs.coverage.embeddingProvider` records which one built
them so mismatches are detectable rather than silently compared.

### How a site gets its design

The website is included and never sold, but it is still the thing the owner
looks at, and nine sites that read as one template is a churn problem before it
is an aesthetic one.

Design is decided **before any markup exists**, by `design_decide`
(`packages/designer`). It emits a nine-field manifest — hero archetype, type
pairing, motion vocabulary, parallax, density, section order, palette strategy,
rationale, catalogue version — and that manifest is rendered into the build
brief between the vertical register and the business facts. The order is
load-bearing: the builder that meets business facts before it meets the rules
reverts to a headline over a photograph.

The agent proposes. `config/design-catalogue.yaml` and the diversity guard
dispose:

- **Catalogue** — every token must exist *and* be permitted for the vertical.
  Permission is the half that matters: `photographic` motion is a real
  vocabulary and a real disaster on a pest-control site, where discretion is
  what is being bought, so that vertical forbids it and no argument from the
  model overrides it. A token outside the catalogue fails the build; adding one
  is a pull request, not a runtime decision.
- **Diversity** — two businesses in one trade must not receive the same
  archetype × type pairing within a window of 8. Checked against stored
  manifests, in code.

A proposal failing either is **replaced wholesale**, never patched — a manifest
half-chosen by a model and half-corrected by code is a design nobody decided.
The same business always produces the same manifest (the chooser is seeded from
its id), so a rebuild cannot silently redesign a live site.

⛔ The diversity rule is arithmetic because the prose version was measured and
failed. Instructed *"two sites in the same vertical must differ"*, the model
varied layout and then put **four of six sites in the same typeface**. A model
asked to avoid an attractor still walks to it. The same trap has a second door:
forcing the `ledger` hero whenever a business publishes a price put **six of
nine trades on one hero**, because most trades publish something — a preference
that always wins is a template. Both are regression-tested with the measured
numbers in `packages/designer/designer.test.ts`.

Every vertical must keep **more archetype × pairing combinations than the
diversity window**, or the ninth customer in that trade becomes unbuildable
during a real onboarding. That invariant is asserted against the catalogue, so
narrowing a vertical fails in CI rather than at 2am.

### Agent runtime cost

The retrieval path makes **zero model calls** — routing is code, and the answer
is a stored row. Cost is incurred only on a fallback, which is metered per turn
in `agent_turns.cost_cents` from what the gateway reports rather than estimated.
Budget from the measured hit rate: at the launch target of 80%, one turn in five
reaches the model; at the month-three target of 93%, one in fourteen. If spend
is higher than that implies, the hit rate is the thing to look at, not the
model.

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
| BytePlus ModelArk (image/video) | `modelark` / `api_key` (+ optional `base_url`) | ⛔ **The only slot that turns on PER-ASSET SPENDING.** Seedream/Seedance generation goes live and `MediaGenerator.billable` flips to true. Nothing generates without an owner's approval and inside their monthly cap either way, but until this key lands the generator is a free simulator. Set a per-customer cap (`POST /agent/:customerId/assets/budget`) before depositing it. | — |
| Google Gemini (fallback rail) | `google_ai` / `api_key` | Real fallback-rail completions | `GOOGLE_AI_API_KEY` |
| Anthropic (pinned CEO/Sentinel) | `anthropic` / `api_key` | Real control-plane completions | `ANTHROPIC_API_KEY` |
| Stripe | `stripe` / `secret_key` | Real card acquiring + subscriptions | `STRIPE_SECRET_KEY` |
| Stripe (webhooks) | `stripe` / `webhook_secret` | Signature-verified webhooks | `STRIPE_WEBHOOK_SECRET` |
| Cloudflare | `cloudflare` / `api_token` | Real Pages/DNS/R2 deploys | `CLOUDFLARE_API_TOKEN` |
| AWS SES | `aws_ses` / `access_key_id` (+ `secret_access_key`) | Real transactional email | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Google Workspace | `google_workspace` / `service_account` | Real cold mailbox provisioning | — |
| Microsoft 365 | `microsoft_365` / `client_secret` | Real second-provider mailboxes | — |
| Lead data (primary/secondary) | `lead_data_primary` / `api_key` | Real licensed record pulls | — |
| Email verification | `email_verification` / `api_key` (+ optional `endpoint`) | Adds a paid verifier behind the free checks. The structural checks — shape, MX, throwaway domains, role accounts — run with or without this key. | — |
| Browserless | `browserless` / `api_key` | Real headless rendering/screenshots | — |
| Twilio | `twilio` / `auth_token` | SMS/voice (Phase 2, counsel-gated) | — |
| Langfuse | `langfuse` / `secret_key` | Real LLM tracing | — |
| Healthchecks.io | `healthchecks` / `ping_url` | Live dead-man's-switch heartbeat | — |
| Pushover | `pushover` / `token` | SEV1 push alerts | — |
| PagerDuty | `pagerduty` / `routing_key` | SEV1 phone escalation (never Twilio) | — |

### 2.1 Exact key sets per capability

A capability goes live only when **every required key** is present. A partially
deposited set stays on the mock — a half-live Cloudflare is worse than a
simulator, because it fails in the middle of a deploy rather than before one.
`VENDOR_CREDENTIAL_KEYS` (exported from `@adw/vendors`) is the machine-readable
form of this table; the Settings screen renders from it.

| Capability | `vendorId` | Required | Optional (default) |
|---|---|---|---|
| SiteHost — Cloudflare Pages | `cloudflare` | `api_token`, `account_id` | `pages_project` (`adw-sites`) |
| DnsProvider — Cloudflare DNS | `cloudflare` | `api_token`, `zone_id` | — |
| ObjectStore — Cloudflare R2 | `cloudflare` | `r2_access_key_id`, `r2_secret_access_key`, `account_id` | `r2_bucket` (`adw-artifacts`) |
| EmailTransport — AWS SES | `aws_ses` | `access_key_id`, `secret_access_key` | `region` (`us-east-1`), `configuration_set` |
| DomainRegistrar — reseller | `registrar_reseller` | `api_key`, `api_user`, `username` | `client_ip` (`127.0.0.1`) |
| PaymentRail — Stripe | `stripe` | `secret_key` | `webhook_secret` |

Two deliberate behaviours worth knowing before you deposit:

- **SES sends `Content.Raw`, not `Content.Simple`.** The simple shape has no
  field for arbitrary headers, so it would accept the message, silently drop
  `List-Unsubscribe` / `List-Unsubscribe-Post`, and report success while
  delivering non-compliant mail. The adapter builds RFC 5322 itself.
- **The cold fleet stays on the simulator even with SES credentials present.**
  Routing cold mail down the brand rail would burn SES's reputation. Cold
  sending goes live when the Workspace/M365/SMTP transports are built, not when
  SES is deposited.

## 2.2 Two acquisition motions, and which one a lead gets

`config/verticals.yaml` marks each of the 60 clusters `smb_local` or
`enterprise_global`, and `config/segments.yaml` gives each segment a track. The
lead workflow asks which track applies immediately after classification, before
the knowledge base, the Q&A pack and the preview — the three expensive steps
that exist to produce a speculative preview.

**SMB (27 clusters, 112 trades).** Unchanged: ingest → grade → preview → cold
email → self-serve claim → published price band.

**Enterprise (33 clusters).** Four refusals, all enforced in code rather than
observed as policy:

| Refusal | Where it bites |
|---|---|
| ⛔ **No speculative preview.** Hosting an unofficial copy of a hospital group's or a bank's website under their name and emailing the link is passing off — a trademark complaint with a legal department attached, and it does not stop being true when the page comes down. | The lead workflow branches before A4/A5/A6, `generate_preview` refuses again at the render (it is also reachable from the revision loop), the config loader will not let the flag be flipped, and a nightly invariant checks no live preview belongs to an enterprise account. |
| ⛔ **No self-serve claim.** Nobody at a 40,000-person company can approve a Q&A pack on the organisation's behalf over a magic link. | `approval_authority: named_signatory`; there is no enterprise claim route. |
| ⛔ **No published price band.** $399 setup and $65/month is not a mispriced enterprise deal, it is a category error. | `pricing_model: quoted`; `recordQuote` requires an amount, a reference and the authenticated operator as approver. |
| ⛔ **Role-relevant outreach only, in every market.** | Gate rule 8c denies enterprise cold mail with no role-relevance statement, regardless of what the jurisdiction requires. |

The enterprise motion is an **opportunity** — a named account moving forward
only through its track's stages, each guarded by evidence that must actually
exist: fit and authority, role relevance, a security questionnaire and DPA with
a named reviewer and a date, an approved quote, a signed agreement. What the
account receives instead of a preview is a **business case**: a document about
their problem, every figure traceable to a deterministic finding, approved by a
human on our side before it is sent.

Operator routes: `GET/POST /ops/opportunities`, `.../evidence`, `.../advance`,
`.../quote`, `.../cases`, `POST /ops/cases/:caseId/approve`.

## 3. Processes and environment

Three processes. Deploying only the first is the most likely way to have a
system that looks healthy and does nothing.

| Process | Command | What breaks without it |
|---|---|---|
| API | `pnpm --filter @adw/api start` | Everything user-facing |
| **Worker** | `pnpm --filter @adw/worker start` | **Durable timers never fire, probes never run, the heartbeat reports the Sentinel dead, asset health never updates, dunning never advances, and nothing ever starts a workflow.** Run ≥1; leadership is a Postgres advisory lock so extra replicas stand by. |
| Static apps | built by Vite, served from any CDN | The four frontends |

Environment variables (secrets belong in your secrets manager, not a repo file):

| Variable | Required in production | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Managed Postgres. Consent ledger needs synchronous replication (RPO 0). |
| `ADW_VAULT_MASTER_KEY` | yes | Envelope-encryption master key. The process **refuses to start** on a well-known demo key outside local/test. |
| `ADW_UNSUBSCRIBE_SECRET` | yes | Signs one-click unsubscribe links. **Never rotate casually** — every link in mail already sent stops verifying, and unsubscribes then fail silently. Rotating means accepting both old and new for the retention window. |
| `ADW_ENV` | yes (`production`) | Anything other than `local`/`test` enables Secure cookies, the weak-key guard, and vault-resolved adapters. |
| `ADW_WEBHOOK_SECRET` | demo only | Shared-secret HMAC for OUR simulators. Refused in live mode — real providers are verified with their own scheme. |
| `ADW_REPLY_TOKEN_SECRET` | yes, if inbound is configured | Signs the plus-addressed `Reply-To` tokens that thread replies. Rotating it orphans every in-flight thread: replies minted under the old secret fail verification and land in the exception queue rather than on their conversation. That is the correct failure — a forged token must not attach a message to someone else's thread — but it is not free. |
| `ADW_INBOUND_ADDRESS` | yes, to receive replies | The address replies come back to, e.g. `reply@inbound.yourdomain`. **Unset means no `Reply-To` header at all**, deliberately: a Reply-To pointing at a mailbox nobody reads is worse than none, because the recipient's client sends there and the reply disappears. |
| `STRIPE_WEBHOOK_SECRET` | yes, with payments | Verifies `Stripe-Signature`. Missing means events are **refused**, not accepted unverified. |
| `ADW_PUBLIC_BASE` | yes | Origin serving `/u/:token` and `/claim`. Must be on `email_links` in `config/allowlists.yaml`. |
| `ADW_BRAND_SENDER` | yes | From-address for transactional mail. |
| `ADW_ALLOWED_ORIGINS` | yes | Comma-separated CORS allowlist. Never a wildcard — the API is credentialed. |
| `ADW_FORCE_MOCK` | no | `1` pins every adapter to its simulator. Use for a production smoke test; unset it to go live. |
| `ADW_ANYCAST_IP` | yes, before any DNS cutover | The apex A-record target customers point their domain at. Must be anycast and stable **forever** — it ends up in third-party zone files we do not control, so it can never be renumbered. Set it before `cutover_dns` runs; the activity refuses without it rather than guessing. |

### 3.1 Webhooks to configure at the vendor

Both endpoints are idempotent and both have effects. Signatures are verified
**per provider, using the scheme that provider actually uses** — SNS RSA over its
canonical field list, Stripe HMAC over `<timestamp>.<body>`.

⛔ This was wrong until recently and worth understanding before you configure
anything. The route verified a shared-secret HMAC in an `x-adw-signature` header
that neither vendor sends, so every genuine bounce notification and every genuine
Stripe event was answered **401** — while the effects suite stayed green by
calling the handler directly. A provider whose scheme is not implemented is now
refused with a reason rather than waved through, and every refusal writes a
`webhook.rejected` event, because a wrong topic ARN and a forgery are both a bare
401 from outside.

The shared-secret path still exists for our own simulators and is **gated on mock
mode**. In a live deployment it is refused: accepting it would let anyone holding
`ADW_WEBHOOK_SECRET` forge a hard bounce and suppress an arbitrary address.

- **SES → SNS → `POST /webhooks/aws_ses`.** Subscribe an SNS topic to the SES
  configuration set for Bounce, Complaint and Delivery. The endpoint handles
  `SubscriptionConfirmation` itself and confirms by fetching the URL Amazon
  supplies — without that handshake the subscription never activates, delivers
  nothing forever, and reports no error at either end. Complaints and permanent
  bounces write the suppression ledger; all three write the message row the
  deliverability control loop scores assets from. **If this is not configured,
  the loop reads zero complaints forever and can never halt a burning domain.**
- **Stripe → `POST /webhooks/stripe`.** Send `invoice.payment_failed`,
  `invoice.paid`, `customer.subscription.deleted`, `charge.dispute.created`.
  Failures start dunning, payments resolve it, disputes raise an exception for a
  human rather than being actioned.

## 4. Setup order (spec §13 — the sequence that avoids rework)

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

## 5. Production infrastructure

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

## 6. Pre-launch gate (Phase 0 exit criterion)

Before any autonomous outreach, all of these must hold (run `pnpm verify &&
pnpm demo` — they are machine-checked):

- Gate 19-case suite green; a cold send from the brand domain is refused.
- Reviewer rejects a deliberately broken build; a clean preview passes.
- Every role has a champion backed by a stored eval run; a grep for hardcoded
  model names in `packages/agents` returns nothing.
- Every T0 vendor has a live probe; the alert chain has been exercised; no
  CUST/PAY vendor is `ACTIVE` with an incomplete diligence file.
- One real preview generated end-to-end under $0.05 (the demo reports the cost).
- **The worker is deployed and holds leadership** (`[worker] LEADER — running jobs`).
- **The unsubscribe endpoint answers on the public origin.** `curl -X POST
  $ADW_PUBLIC_BASE/u/test` must return a 404 JSON body, not a connection error
  or an HTML 404 from a CDN — a link that does not resolve is worse than no
  link, and every cold message carries one.
- **Both webhook endpoints are registered at the vendor** and a test delivery
  returns `handled: true`.
- **No customer agent is live without a passing 30-case eval run.** Checked
  nightly; also enforced in `OnboardingWorkflow`, where delivery sits behind
  `agent_eval_gate`.
- **`ADW_ANYCAST_IP` is set and reachable** before the first DNS cutover. 86% of
  these domains have live MX, and `verifyCutover` reverts and raises SEV1 on any
  mail-record delta — but a cutover pointed at nothing is still an outage.
- **The retrieval hit rate is being measured on real traffic.** The nightly check
  needs 50 retrieval turns in the window before it can judge; below that it
  reports the count and passes. Treat "below the sample needed" as *not yet
  verified*, not as green.

## 7. Open items requiring counsel before Phase 1 (spec §19)

Photo-licensing position for speculative previews · `relates_to_role` template
wording · AI-disclosure timing · vendor data-licence terms (incl. screenshotting
the source page) · payments-licensing confirmation per market. These are tracked
but not resolvable in code.

**v3 additions.** The customer's terms must state plainly that the agent answers
only from content they approved, and that they own what it says — the *Moffatt*
position is theirs, and the grounding architecture plus the `agent_turns`
transcript is what defends it. Counsel should also confirm the wording of the
agent's AI disclosure per market, and whether the setup fee is characterised as
a service fee anywhere it would attract different treatment from a subscription.
