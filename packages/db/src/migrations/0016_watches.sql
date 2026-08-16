-- Watchers for the customer's market (catalogue MF7 — 92 units).
--
-- The Sentinel already watches OUR vendors: probes, signals, a heartbeat, a
-- remediation allowlist. Every one of those 92 units is the same machine
-- pointed outward — at the customer's reviews, their listing, their ranking, a
-- competitor's price list, a register they appear on, a rule that changed.
-- Nothing in this system looked outward on a customer's behalf.
--
-- ⛔ Three tables, not one, because the distinction they encode is the whole
-- family: a SUBSCRIPTION is what we promised to watch, an OBSERVATION is what
-- we actually saw and when, and a FINDING is a CHANGE between two observations.
-- Collapsing them is how a watch board comes to show a green tick and a value
-- that was last fetched in March.

CREATE TABLE IF NOT EXISTS watch_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  watch_id      TEXT NOT NULL,             -- config/watches.yaml id
  -- What is being watched: a place id, a URL, a competitor name, a register
  -- number. Opaque here; the collector for the watch's source understands it.
  subject       TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  -- ⛔ Separate from last_run_at, and the only one that means anything. A watch
  -- that ran and failed has a fresh last_run_at and a stale value; reporting on
  -- the first is how "we are watching this" survives the watching stopping.
  last_ok_at    TIMESTAMPTZ,
  consecutive_failures SMALLINT NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, watch_id, subject)
);
CREATE INDEX IF NOT EXISTS watch_subscriptions_due
  ON watch_subscriptions (last_run_at) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS watch_observations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES watch_subscriptions(id) ON DELETE CASCADE,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok              BOOLEAN NOT NULL,
  -- NULL on a failed observation. ⛔ A failure must never carry forward the
  -- previous value: the row that says "we could not see" has to be
  -- distinguishable from the row that says "it is unchanged", and a copied
  -- value makes them identical.
  value           JSONB,
  value_hash      TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS watch_observations_recent
  ON watch_observations (subscription_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS watch_observations_last_ok
  ON watch_observations (subscription_id, observed_at DESC) WHERE ok = TRUE;

CREATE TABLE IF NOT EXISTS watch_findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES watch_subscriptions(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id),
  watch_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- which rule fired
  summary         TEXT NOT NULL,
  detail          JSONB NOT NULL DEFAULT '{}',
  severity        SMALLINT NOT NULL,
  from_hash       TEXT,
  to_hash         TEXT,
  -- ⛔ The de-duplication key. A price that oscillates between two values twice
  -- a day is one finding, not fifty-six a fortnight, and a queue that floods is
  -- a queue that gets ignored — which is indistinguishable from not watching.
  finding_key     TEXT NOT NULL,
  found_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  dismissed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS watch_findings_open
  ON watch_findings (customer_id, severity, found_at DESC)
  WHERE acknowledged_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS watch_findings_dedupe
  ON watch_findings (subscription_id, finding_key, found_at DESC);
