-- Cases and the owner's queue (catalogue MF2 — 80 units, MF3 — 52 units).
--
-- MF2 is "long-running case objects with stages, clocks and updates — matters,
-- claims, tickets, NCRs, permits, applications". The only long-running objects
-- in this system were ADW's own `workflow_executions`. The customer had none.
--
-- MF3 is the queue. `exceptions` existed with ten insert sites, all of them
-- ADW vendor-ops, and `status` never left 'open': there was no acknowledge
-- writer, no resolve writer, no assignee, no due date, and the console's
-- Approve/Reject buttons had no handler. A queue nothing can be cleared from is
-- a list.

CREATE TABLE IF NOT EXISTS cases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  case_type     TEXT NOT NULL,             -- config/case-types.yaml id
  type_version  TEXT NOT NULL,
  reference     TEXT NOT NULL,             -- what the customer calls it
  title         TEXT NOT NULL,
  stage         TEXT NOT NULL,
  -- ⛔ The clock is per STAGE, not per case. "Open for 40 days" is normal for a
  -- conveyance and a scandal for a complaint; what matters is how long it has
  -- sat in the stage it is in.
  stage_since   TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage_due_at  TIMESTAMPTZ,
  contact       TEXT,
  session_id    UUID REFERENCES agent_sessions(id),
  closed_at     TIMESTAMPTZ,
  close_reason  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, case_type, reference)
);
CREATE INDEX IF NOT EXISTS cases_open ON cases (customer_id, stage_due_at) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS cases_overdue ON cases (stage_due_at) WHERE closed_at IS NULL AND stage_due_at IS NOT NULL;

-- Every stage transition, append-only. "Why did this take five weeks" is a
-- question with an answer or it is a question with an argument.
CREATE TABLE IF NOT EXISTS case_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES cases(id),
  kind        TEXT NOT NULL,               -- 'stage'|'note'|'document'|'message'
  from_stage  TEXT,
  to_stage    TEXT,
  detail      TEXT,
  actor       TEXT NOT NULL,
  -- ⛔ Whether the CUSTOMER may see this. A case note saying "client is being
  -- difficult" is an internal note, and a status page that leaks one costs the
  -- business the client.
  customer_visible BOOLEAN NOT NULL DEFAULT FALSE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_events_case ON case_events (case_id, at DESC);

-- --- MF3: the queue lifecycle the exceptions table never had ---------------
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS assignee TEXT;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
-- `resolved_at` and `resolved_by` already exist and were never written to.
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS resolution TEXT;
-- Whose queue: null is ADW's own operations, a customer id is the owner's.
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS exceptions_queue
  ON exceptions (customer_id, severity, raised_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS exceptions_overdue
  ON exceptions (due_at) WHERE resolved_at IS NULL AND due_at IS NOT NULL;
