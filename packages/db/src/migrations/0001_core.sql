-- ADW core schema (software documentation Ch. 6). Column types are indicative;
-- constraints are the point. Money is always integer minor units. Timestamps
-- are TIMESTAMPTZ UTC. Nothing legally significant lives only in ClickHouse.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Acquisition domain
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor        TEXT NOT NULL,
  licence_ref   TEXT NOT NULL,              -- contract ref permitting this use; ingestion rejects a batch without it
  record_count  INT NOT NULL,
  cost_cents    INT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum      TEXT NOT NULL
);

CREATE TABLE campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  region_code     TEXT NOT NULL,
  enabled_markets TEXT[] NOT NULL DEFAULT '{}',
  message_class   TEXT NOT NULL DEFAULT 'web_presence',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_vendor     TEXT NOT NULL,           -- never 'self_scrape'
  source_batch_id   UUID NOT NULL REFERENCES ingest_batches(id),
  external_ref      TEXT,
  name              TEXT NOT NULL,
  category_raw      TEXT,
  category          TEXT,                    -- normalised trade taxonomy
  country_code      CHAR(2) NOT NULL,
  region_code       TEXT NOT NULL,           -- R1..R4, derived
  admin_area        TEXT,
  city              TEXT,
  postal_code       TEXT,
  lat               NUMERIC(9,6),
  lng               NUMERIC(9,6),
  phone_e164        TEXT,
  website_url       TEXT,                    -- NULL => segment 'no_site'
  segment           TEXT NOT NULL,           -- 'no_site' | 'stale_site' | 'ok_site'
  review_count      INT,
  rating            NUMERIC(2,1),
  photo_refs        JSONB,                   -- vendor refs, NOT copies
  hours             JSONB,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_vendor, external_ref)
);
CREATE INDEX businesses_region_seg_cat ON businesses (region_code, segment, category);
CREATE INDEX businesses_country_city ON businesses (country_code, city);

-- ---------------------------------------------------------------------------
-- Contact and provenance — the legal artifact
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id),
  email             CITEXT NOT NULL,
  email_hash        BYTEA NOT NULL,          -- sha256(lower(email))
  verification      TEXT NOT NULL,           -- 'valid'|'risky'|'invalid'|'unknown'
  verified_at       TIMESTAMPTZ,
  verifier          TEXT,
  role_inferred     TEXT,                    -- 'owner'|'manager'|'generic'|'unknown'
  subscriber_type   TEXT,                    -- 'corporate'|'sole_trader'|'unknown'
  registry_ref      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, email)
);
CREATE INDEX contacts_email_hash ON contacts (email_hash);

CREATE TABLE provenance (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         UUID NOT NULL REFERENCES contacts(id),
  source_url         TEXT NOT NULL,
  retrieved_at       TIMESTAMPTZ NOT NULL,
  screenshot_r2_key  TEXT NOT NULL,          -- immutable, content-addressed
  page_hash          TEXT NOT NULL,
  no_cem_statement   BOOLEAN NOT NULL,       -- TRUE => no "do not email" found
  detector_version   TEXT NOT NULL,
  relates_to_role    BOOLEAN NOT NULL,
  legal_basis        TEXT NOT NULL,
  reviewed_by        TEXT,
  reviewed_at        TIMESTAMPTZ
);
CREATE INDEX provenance_contact ON provenance (contact_id, retrieved_at DESC);

-- ---------------------------------------------------------------------------
-- Suppression — append-only, global, cross-channel
-- ---------------------------------------------------------------------------
CREATE TABLE suppression (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash     BYTEA,
  phone_hash     BYTEA,
  domain         TEXT,
  reason         TEXT NOT NULL,   -- 'unsubscribe'|'complaint'|'hard_bounce'|'takedown'|'legal_request'|'manual'|'dnc_registry'|'role_account'
  channel_scope  TEXT NOT NULL DEFAULT 'all',
  source_event   UUID,
  suppressed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email_hash IS NOT NULL OR phone_hash IS NOT NULL OR domain IS NOT NULL)
);
CREATE UNIQUE INDEX suppression_email ON suppression (email_hash) WHERE email_hash IS NOT NULL;
CREATE UNIQUE INDEX suppression_phone ON suppression (phone_hash) WHERE phone_hash IS NOT NULL;
CREATE UNIQUE INDEX suppression_domain ON suppression (domain) WHERE domain IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Sending assets and gate decisions
-- ---------------------------------------------------------------------------
CREATE TABLE sending_assets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL,           -- 'mailbox'|'domain'
  provider       TEXT NOT NULL,           -- 'google'|'microsoft'|'smtp_vendor'|'ses'
  identifier     TEXT NOT NULL UNIQUE,
  domain_class   TEXT NOT NULL,           -- 'burner'|'brand'
  pool           TEXT NOT NULL,
  health         TEXT NOT NULL,           -- 'warming'|'healthy'|'warn'|'throttled'|'halted'|'retired'
  daily_cap      SMALLINT NOT NULL,
  sends_today    INT NOT NULL DEFAULT 0,
  warmup_started TIMESTAMPTZ,
  first_send_at  TIMESTAMPTZ,
  retired_at     TIMESTAMPTZ,
  retire_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gate_decisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  allow          BOOLEAN NOT NULL,
  rule_id        TEXT,
  reason         TEXT,
  contact_hash   BYTEA,
  channel        TEXT NOT NULL,
  message_class  TEXT NOT NULL,
  jurisdiction   TEXT,
  legal_basis    TEXT,
  config_version TEXT NOT NULL,
  obligations    JSONB
);
CREATE INDEX gate_decisions_decided ON gate_decisions (decided_at DESC);

-- ---------------------------------------------------------------------------
-- Lead and conversation
-- ---------------------------------------------------------------------------
CREATE TABLE previews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id),
  r2_key        TEXT NOT NULL,
  deploy_url    TEXT NOT NULL,
  claim_token   TEXT NOT NULL UNIQUE,
  noindex       BOOLEAN NOT NULL DEFAULT TRUE,
  label_version TEXT NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  claimed_at    TIMESTAMPTZ,
  takedown_at   TIMESTAMPTZ,
  takedown_reason TEXT,
  cost_cents    NUMERIC(10,4)
);

CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID NOT NULL REFERENCES contacts(id),
  campaign_id     UUID NOT NULL REFERENCES campaigns(id),
  state           TEXT NOT NULL,
  score           NUMERIC(5,2),
  score_version   TEXT,
  preview_id      UUID REFERENCES previews(id),
  sequence_step   SMALLINT NOT NULL DEFAULT 0,
  workflow_id     TEXT NOT NULL,
  entered_state_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cooldown_until  TIMESTAMPTZ,
  UNIQUE (contact_id, campaign_id)
);
-- one non-terminal lead per contact
CREATE UNIQUE INDEX leads_one_active_per_contact ON leads (contact_id)
  WHERE state NOT IN ('WON','LOST','EXHAUSTED','SUPPRESSED','CANCELLED');

CREATE TABLE customers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id),
  region_code    TEXT NOT NULL,
  legal_name     TEXT NOT NULL,
  contact_email  CITEXT NOT NULL,
  locale         TEXT NOT NULL,
  timezone       TEXT NOT NULL,
  stripe_customer_id TEXT,
  status         TEXT NOT NULL,           -- 'active'|'past_due'|'cancelled'|'refunded'
  won_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at   TIMESTAMPTZ,
  cancel_reason  TEXT
);

CREATE TABLE conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID REFERENCES leads(id),
  customer_id  UUID REFERENCES customers(id),
  channel      TEXT NOT NULL,             -- 'email'|'sms'|'whatsapp'|'dashboard'
  intent_score SMALLINT,
  stage        TEXT,
  summary      TEXT,
  summary_through_message_id UUID,
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id),
  direction        TEXT NOT NULL,          -- 'outbound'|'inbound'
  channel          TEXT NOT NULL,
  sending_asset_id UUID REFERENCES sending_assets(id),
  subject          TEXT,
  body_r2_key      TEXT NOT NULL,
  body_hash        TEXT NOT NULL,
  gate_decision_id UUID REFERENCES gate_decisions(id),
  idempotency_key  TEXT NOT NULL UNIQUE,
  role_id          TEXT,
  model_used       TEXT,
  tokens_in        INT,
  tokens_out       INT,
  cost_cents       NUMERIC(10,4),
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  opened_at        TIMESTAMPTZ,
  replied_at       TIMESTAMPTZ,
  bounced_at       TIMESTAMPTZ,
  complained_at    TIMESTAMPTZ
);
CREATE INDEX messages_conversation ON messages (conversation_id, sent_at);

-- ---------------------------------------------------------------------------
-- Build and artefact
-- ---------------------------------------------------------------------------
CREATE TABLE builds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id),
  customer_id       UUID REFERENCES customers(id),
  parent_build_id   UUID REFERENCES builds(id),
  mode              TEXT NOT NULL,          -- 'preview'|'full'|'revision'
  role_chain        JSONB NOT NULL,
  escalation_depth  SMALLINT NOT NULL DEFAULT 0,
  first_pass        BOOLEAN NOT NULL,
  gate_results      JSONB NOT NULL,         -- every check, full numeric value
  cost_cents        NUMERIC(10,4) NOT NULL,
  artefact_r2_key   TEXT NOT NULL,
  deployed_url      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Customer / subscription / money
-- ---------------------------------------------------------------------------
CREATE TABLE subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id),
  plan_code           TEXT NOT NULL,
  billing_interval    TEXT NOT NULL,        -- 'month'|'year'
  amount_cents        INT NOT NULL,
  currency            CHAR(3) NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  status              TEXT NOT NULL,
  current_period_end  TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  addon_code      TEXT NOT NULL,
  amount_cents    INT NOT NULL,
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  detached_at     TIMESTAMPTZ
);

CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id),
  subscription_id UUID REFERENCES subscriptions(id),
  amount_cents    INT NOT NULL,
  currency        CHAR(3) NOT NULL,
  status          TEXT NOT NULL,           -- 'draft'|'open'|'paid'|'void'|'uncollectible'
  stripe_invoice_id TEXT UNIQUE,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ
);

CREATE TABLE refunds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  amount_cents  INT NOT NULL,
  currency      CHAR(3) NOT NULL,
  reason        TEXT NOT NULL,             -- 'guarantee'|'goodwill'|'error'|'dispute_avoid'
  requested_via TEXT NOT NULL,             -- 'email_keyword'|'dashboard'|'agent'|'operator'
  auto_approved BOOLEAN NOT NULL,
  stripe_refund_id TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Control plane: exceptions, kill switches, feature flags
-- ---------------------------------------------------------------------------
CREATE TABLE exceptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger       TEXT NOT NULL,
  severity      SMALLINT NOT NULL,        -- 1..4
  context       JSONB NOT NULL,
  system_action TEXT,                     -- what the system already did
  recommendation TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- 'open'|'acknowledged'|'resolved'
  resolved_by   TEXT,
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX exceptions_open ON exceptions (status, severity, raised_at DESC);

CREATE TABLE kill_switches (
  name          TEXT PRIMARY KEY,        -- HALT_ALL_SENDING, HALT_COLD_ONLY, ...
  engaged       BOOLEAN NOT NULL DEFAULT FALSE,
  toggled_by    TEXT,
  toggled_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  key           TEXT PRIMARY KEY,
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  description   TEXT,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Event store (Postgres EventSink; ClickHouse adapter uses the same envelope)
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind  TEXT,
  actor_id    TEXT,
  subject_kind TEXT,
  subject_id  TEXT,
  region      TEXT,
  campaign_id UUID,
  cost_cents  NUMERIC(12,6),
  model       TEXT,
  trace_id    TEXT,
  payload     JSONB
);
CREATE INDEX events_type_time ON events (event_type, occurred_at DESC);
CREATE INDEX events_trace ON events (trace_id);

-- ---------------------------------------------------------------------------
-- Reference data (mirrors of PR-gated config files)
-- ---------------------------------------------------------------------------
CREATE TABLE jurisdictions (
  country_code CHAR(2) PRIMARY KEY,
  config       JSONB NOT NULL,
  config_version TEXT NOT NULL,
  loaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trade_taxonomy (
  category     TEXT PRIMARY KEY,
  family       TEXT NOT NULL,
  prohibited   BOOLEAN NOT NULL DEFAULT FALSE
);
