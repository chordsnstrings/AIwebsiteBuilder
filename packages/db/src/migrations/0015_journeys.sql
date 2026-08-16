-- Customer clocks and journeys (catalogue MF4 — 73 units, MF5 — 54 units).
--
-- MF4 is "renewal, recall, statutory, covenant, AR and reminder dates". The
-- durable timer engine genuinely works, and there was exactly ONE production
-- `ctx.sleep` in the entire repository: a 180-day lead cooldown. No date was
-- bound to any customer-facing event at all.
--
-- MF5 is multi-touch follow-up, save, reactivation and referral journeys. That
-- existed only for ADW's own cold outreach — the platform mistaken for the
-- product.
--
-- ⛔ Both are stored as ROWS WITH DUE TIMES rather than as sleeping workflows.
-- A dental recall is 6 months away and a tenancy renewal 11 months; parking
-- 50,000 workflow executions on multi-month sleeps makes every engine upgrade a
-- migration of live sleeping state. A due-date table is queryable, correctable
-- by a human, and survives a redeploy without ceremony.

CREATE TABLE IF NOT EXISTS reminders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  kind          TEXT NOT NULL,             -- config/clocks.yaml id
  subject_ref   TEXT NOT NULL,             -- who or what it is about
  contact       TEXT,
  -- The fact the date is derived from: a certificate expiry, a last visit, an
  -- invoice due date. Kept because a reminder whose anchor is unknown cannot be
  -- re-derived when the clock definition changes.
  anchor_at     TIMESTAMPTZ NOT NULL,
  due_at        TIMESTAMPTZ NOT NULL,
  -- ⛔ Statutory clocks are marked, and never silently rescheduled. A recall
  -- can slip a fortnight; a licence renewal date is a fact about the law. The
  -- flag is written from config/clocks.yaml, never from a caller argument.
  statutory     BOOLEAN NOT NULL DEFAULT FALSE,
  fired_at      TIMESTAMPTZ,
  delivered     BOOLEAN,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,
  -- Who moved a statutory date, and why. NULL on every automatic reschedule,
  -- because an automatic reschedule of a statutory date is refused.
  moved_at      TIMESTAMPTZ,
  moved_by      TEXT,
  moved_reason  TEXT,
  source_case_id UUID REFERENCES cases(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ⛔ At most ONE pending reminder of a kind per subject. Not a plain UNIQUE on
-- (customer, kind, subject, due_at): that would let a corrected anchor date
-- leave the old reminder standing, so the tenant gets told their gas safety
-- certificate expires on two different days.
CREATE UNIQUE INDEX IF NOT EXISTS reminders_one_pending
  ON reminders (customer_id, kind, subject_ref)
  WHERE fired_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS reminders_due
  ON reminders (due_at) WHERE fired_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS reminders_customer ON reminders (customer_id, due_at);

-- A person moving through a multi-touch journey.
CREATE TABLE IF NOT EXISTS journey_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  journey_id    TEXT NOT NULL,             -- config/journeys.yaml id
  journey_version TEXT NOT NULL,
  subject_ref   TEXT NOT NULL,
  contact       TEXT NOT NULL,
  step_index    SMALLINT NOT NULL DEFAULT 0,
  next_step_at  TIMESTAMPTZ,
  state         TEXT NOT NULL DEFAULT 'running',  -- 'running'|'completed'|'stopped'
  stop_reason   TEXT,
  -- A contact that keeps failing must fall out of the sequence rather than be
  -- retried until the end of time.
  failures      SMALLINT NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_step_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ⛔ One RUNNING run per subject per journey. Two overlapping reactivation
-- sequences means the same person is messaged twice on the same day by the same
-- business, which is the fastest route to an unsubscribe. Completed and stopped
-- runs stay as history, and a subject may legitimately enter the same journey
-- again a year later — so this is partial rather than a table-wide UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS journey_runs_one_active
  ON journey_runs (customer_id, journey_id, subject_ref) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS journey_runs_due
  ON journey_runs (next_step_at) WHERE state = 'running';

-- Every step actually delivered. The journey run holds the pointer; this holds
-- the evidence, so "we messaged this person four times in nine days" is a query
-- rather than an inference from a step counter.
CREATE TABLE IF NOT EXISTS journey_steps_sent (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES journey_runs(id) ON DELETE CASCADE,
  step_index    SMALLINT NOT NULL,
  template      TEXT NOT NULL,
  detail        TEXT,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index)
);
