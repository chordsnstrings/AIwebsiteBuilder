# ADW — Autonomous Website Foundry

An autonomous system that finds small businesses with weak or missing web
presence, generates speculative preview sites, runs compliant cold outreach,
converts replies through AI sales conversations, builds full sites gated by
deterministic reviewers, and bills subscriptions — governed by a deterministic
compliance gate, an in-house model gateway, a vendor Sentinel and a vendor
onboarding orchestrator.

This repository is the complete v1 implementation. **It runs fully in keyless
demo mode**: every external vendor sits behind an adapter with a mock
implementation, selected automatically when no credential is present in the
vault. Deposit real vendor credentials through the superadmin **Settings/Vault**
surface to flip each vendor from mock to live — see `DEPLOYMENT.md`.

## Quick start (demo mode, no vendor keys required)

```bash
pnpm install
pnpm vault:init          # generates a demo vault master key in .env.local
pnpm db:start            # cold-starts the in-sandbox Postgres 16 server
pnpm db:migrate          # applies schema, roles, grants, append-only triggers
pnpm seed                # seeds demo businesses, leads, previews, customers, vendors
pnpm verify              # typecheck + lint + full test suite
pnpm demo                # boots the API + apps and runs the end-to-end demo
```

## Architecture

- **`packages/gate`** — the compliance gate. Deterministic, no model, fails
  closed. Every outbound message passes through `gate()`; there is no second
  path (lint-enforced).
- **`packages/gateway` + `packages/registry`** — in-house model gateway
  (ModelArk primary / Google fallback / Anthropic pinned), data-class
  enforcement, per-role cost-per-passing-output budgets, escalation, and an
  eval-selected role registry. No model name appears in agent code
  (lint-enforced).
- **`packages/agents`** — the agent roster: 26 typed activities with capability
  unions, one for each role the registry resolves to a model. Capabilities like
  `write:config` / `charge:money` do not exist in the type. Six further roles in
  the system are deterministic code with no model at all and correctly appear in
  neither list.
- **`packages/designer`** — decides how a site looks before any markup exists.
  The model proposes five tokens; `config/design-catalogue.yaml` and a diversity
  guard dispose. Two businesses in one trade cannot receive the same hero and
  the same typeface — enforced in code, because the prose version of that rule
  produced four identical typefaces out of six.
- **`packages/workflows`** — an in-house journaled-step durable workflow engine
  with Temporal-shaped semantics (durable timers, signals, versioning) and a
  time-skipping test engine. Swappable for Temporal Cloud later.
- **`packages/sentinel`** — deterministic vendor probes, passive signals, a
  remediation allowlist and a dead-man's-switch heartbeat.
- **`packages/orchestrator`** — the 66-vendor lifecycle state machine. Prepares,
  provisions and monitors; never creates accounts, never signs.
- **`packages/vault`** — envelope-encrypted credentials. Agents hold opaque
  `CredentialRef`s; secrets are resolved only inside vendor adapters.
- **`packages/auth`** — scrypt sessions indexed by `sha256(token)`, RFC 6238 TOTP
  (mandatory for the superadmin, verified against the spec's test vectors), and
  an Origin-based CSRF check. Zero native dependencies.
- **`packages/dsar`** — subject access export as a signed archive, and an
  erasure routine that deliberately retains the email hash, the suppression row
  and the provenance evidence.
- **`packages/reports`** — the monthly value report, every figure from a
  deterministic query, with no upsell in a month where the metrics are down.
- **`apps/api`** — the internal API surface: the sole `/gate/evaluate` transport
  route, registry-resolved completions, append-only ledgers, operator surfaces
  behind superadmin auth, and signature-verified idempotent webhooks.
- **`apps/ops`** — the superadmin console: exceptions, kill switches, health,
  registry, cost, search, DSAR, and the Settings/Vault surface where credentials
  are deposited to go live.
- **`evals/`** — the adversarial suites: 10 injection cases, 30 scripted care
  objections, 15 IP/claims cases held to 100% recall, and 20 fixture businesses.
- **`config/*.yaml`** — jurisdiction matrix, thresholds, pricing, allowlists and
  more. PR-gated; never editable at runtime through any UI.

See `docs/` and the plan for the full component map.

## Governance invariants (enforced in code + tests)

- Cold rail and brand rail never touch (`channel.domain_class == message.class`).
- Suppression, provenance and gate decisions are append-only (DB triggers + role
  grants).
- `tos_acceptance` is writable only by the payments acceptance webhook handler
  (DB trigger + lint rule).
- Every connected payment account is `charge_type = direct` (DB constraint).
- No model identifier appears in agent or workflow code (lint rule).
- The compliance config is changed only by pull request, never a runtime toggle.
