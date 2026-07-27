-- Workflow engine, vault, auth, model registry, vendor registry, payments.

-- ---------------------------------------------------------------------------
-- Durable workflow engine (journaled-step)
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_executions (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',  -- running|completed|failed|paused
  input         JSONB,
  result        JSONB,
  error         TEXT,
  cursor        INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflow_exec_status ON workflow_executions (status);

CREATE TABLE workflow_journal (
  execution_id  TEXT NOT NULL REFERENCES workflow_executions(id),
  seq           INT NOT NULL,
  kind          TEXT NOT NULL,   -- activity|timer|signal_wait|condition|patch|side_effect
  name          TEXT NOT NULL,
  result        JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, seq)
);

CREATE TABLE workflow_timers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id  TEXT NOT NULL REFERENCES workflow_executions(id),
  name          TEXT NOT NULL,
  fire_at       TIMESTAMPTZ NOT NULL,
  fired         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX workflow_timers_due ON workflow_timers (fire_at) WHERE fired = FALSE;

CREATE TABLE workflow_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id  TEXT NOT NULL REFERENCES workflow_executions(id),
  name          TEXT NOT NULL,
  payload       JSONB,
  delivered     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflow_signals_undelivered ON workflow_signals (execution_id) WHERE delivered = FALSE;

-- ---------------------------------------------------------------------------
-- Vault — envelope-encrypted credentials. Agents hold opaque CredentialRefs.
-- ---------------------------------------------------------------------------
CREATE TABLE vault_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     TEXT NOT NULL,
  key_name      TEXT NOT NULL,
  version       INT NOT NULL DEFAULT 1,
  dek_wrapped   BYTEA NOT NULL,     -- data encryption key, wrapped by master key
  ciphertext    BYTEA NOT NULL,
  nonce         BYTEA NOT NULL,
  aad           TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,      -- sha256 prefix of plaintext, for display only
  expires_at    TIMESTAMPTZ,
  rotated_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, key_name, version)
);

CREATE TABLE vault_access_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     TEXT NOT NULL,
  key_name      TEXT NOT NULL,
  action        TEXT NOT NULL,     -- 'deposit'|'resolve'|'rotate_request'|'delete_deny'
  actor         TEXT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT NOT NULL UNIQUE,
  password_hash  TEXT,
  role           TEXT NOT NULL DEFAULT 'customer',   -- 'superadmin'|'customer'
  customer_id    UUID REFERENCES customers(id),
  totp_secret    TEXT,
  totp_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,        -- sha256(token)
  user_id       UUID NOT NULL REFERENCES users(id),
  expires_at    TIMESTAMPTZ NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Model registry + eval runs
-- ---------------------------------------------------------------------------
CREATE TABLE eval_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role          TEXT NOT NULL,
  suite         TEXT NOT NULL,
  candidate     TEXT NOT NULL,
  metric        TEXT NOT NULL,
  metric_value  NUMERIC(12,6) NOT NULL,
  pass_rate     NUMERIC(5,4),
  first_pass_rate NUMERIC(5,4),
  cases_total   INT,
  cases_passed  INT,
  detail        JSONB,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eval_runs_role ON eval_runs (role, run_at DESC);

CREATE TABLE registry_roles (
  role            TEXT PRIMARY KEY,
  candidates      JSONB NOT NULL,         -- ModelRef[]
  champion        TEXT,                   -- ModelRef; NULL until an eval run selects one
  champion_since  TIMESTAMPTZ,
  champion_metric NUMERIC(12,6),
  champion_eval_run_id UUID REFERENCES eval_runs(id),
  escalation      JSONB NOT NULL DEFAULT '[]',
  eval_suite      TEXT,
  selection_metric TEXT NOT NULL,
  re_eval_cadence TEXT NOT NULL,
  data_class      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',   -- 'active'|'pending'
  fallback_last_ok TIMESTAMPTZ
);

CREATE TABLE registry_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role          TEXT NOT NULL,
  old_champion  TEXT,
  new_champion  TEXT,
  eval_run_id   UUID REFERENCES eval_runs(id),
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Vendor registry (Vendor Onboarding Orchestrator lifecycle)
-- ---------------------------------------------------------------------------
CREATE TABLE vendors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  tier            TEXT NOT NULL,          -- 'T0'|'T1'|'T2'|'T3'
  data_class      TEXT NOT NULL,          -- 'PUB'|'CUST'|'PAY'|'NONE'
  gate            TEXT NOT NULL,          -- 'self_serve'|'contract'|'counsel'
  category        TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'IDENTIFIED',
  diligence       JSONB NOT NULL DEFAULT '{}',   -- 9 questions answered/missing/blocking
  credential_refs JSONB NOT NULL DEFAULT '[]',
  probe_status    TEXT,                   -- 'passing'|'failing'|'unknown'
  probe_last_ok   TIMESTAMPTZ,
  renewal_at      TIMESTAMPTZ,
  notice_period_days INT,
  balance_days    INT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     TEXT,
  failure_class TEXT NOT NULL,
  severity      SMALLINT NOT NULL,
  blast_radius  JSONB,
  diagnosis     TEXT,
  runbook_ref   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);

CREATE TABLE probe_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     TEXT NOT NULL,
  probe_name    TEXT NOT NULL,
  passed        BOOLEAN NOT NULL,
  latency_ms    INT,
  detail        TEXT,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX probe_results_vendor ON probe_results (vendor_id, ran_at DESC);

CREATE TABLE heartbeats (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,
  beat_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX heartbeats_source ON heartbeats (source, beat_at DESC);

-- ---------------------------------------------------------------------------
-- Payments facilitation — merchant connected accounts
-- ---------------------------------------------------------------------------
CREATE TABLE merchant_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id),
  rail_id           TEXT NOT NULL,          -- stripe|paystack|...
  external_account_id TEXT,
  business_type     TEXT,                   -- 'company'|'individual'
  charge_type       TEXT NOT NULL DEFAULT 'direct',   -- MUST be 'direct'
  requirement_collection TEXT NOT NULL DEFAULT 'stripe',
  charges_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  payouts_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  statement_descriptor TEXT,
  tos_acceptance    JSONB,                  -- writable ONLY by the acceptance webhook handler
  state             TEXT NOT NULL DEFAULT 'PRE_SCREEN',
  currently_due     JSONB NOT NULL DEFAULT '[]',
  integration_test_passed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dunning_state (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  step            SMALLINT NOT NULL DEFAULT 0,
  next_action_at  TIMESTAMPTZ,
  pause_at        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
