-- Somewhere to put the monthly value report (§58).
--
-- ⛔ `@adw/reports` had ZERO consumers anywhere in the repository. Written,
-- tested, exported, and imported by nothing — no job produced a report, no
-- table held one, no route served one, no screen showed one. It is the single
-- artefact that answers "what did I get for my money", which is the question
-- that decides whether a subscription renews, and it had never been generated
-- for a single customer.
--
-- The report is stored rather than computed on read, for one reason that
-- matters: §58 requires every figure to come from a deterministic query over
-- the period, and a period that has closed cannot change. Recomputing later
-- would let a backfill or a retention sweep silently restate a month the
-- customer has already read.

CREATE TABLE IF NOT EXISTS value_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  period_year   INT NOT NULL,
  period_month  INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  -- The whole ValueReport as generated, including the single suggestion.
  report        JSONB NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ⛔ One report per customer per month, enforced here rather than by the
  -- job remembering. An hourly job that re-inserts on every pass would give a
  -- customer twelve copies of January.
  UNIQUE (customer_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS value_reports_customer
  ON value_reports (customer_id, period_year DESC, period_month DESC);
