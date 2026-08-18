-- Whether the recurring work is actually running.
--
-- ⛔ Before this table the scheduler kept its stats in a process-local Map, so
-- the only way to know whether a job had ever run was to read the worker's
-- stdout. The ops console could not see it, which meant the console could not
-- answer the single most important question about an autonomous system: is it
-- running? A dashboard that cannot answer that is decoration.
--
-- ⛔ `last_run_at` and `last_success_at` are SEPARATE COLUMNS, and this is the
-- whole point of the table. The scheduler's in-memory stats stamped one
-- timestamp in a `finally` block, so a job failing every ten seconds looked
-- exactly as fresh as a job succeeding every ten seconds. Health is measured
-- from `last_success_at` and from nothing else.
CREATE TABLE IF NOT EXISTS job_heartbeats (
  job_name              text PRIMARY KEY,
  -- Declared at registration, so the reader can judge freshness against the
  -- job's OWN cadence instead of one blanket timeout. A 10s timer job and a
  -- 24h retention job are not stale at the same age.
  interval_ms           bigint NOT NULL CHECK (interval_ms > 0),
  -- Written at registration, before any run. A job that has never run has a
  -- row with NULLs rather than no row at all — otherwise "never ran once" and
  -- "not deployed" are the same absence, and unmeasured renders as nothing.
  registered_at         timestamptz NOT NULL DEFAULT now(),
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  last_error            text,
  last_duration_ms      integer,
  runs_total            bigint NOT NULL DEFAULT 0,
  failures_total        bigint NOT NULL DEFAULT 0,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  -- Non-leader replicas skip most jobs entirely. Without this the spare replica
  -- would report every leader-gated job as never-run and page somebody.
  last_leader           boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ⛔ A success may never move the clock backwards, and a failure may never
-- advance `last_success_at`. Enforced here rather than in the writer because
-- the writer is one upsert away from being copied wrongly, and this is the
-- column every green light on the console is computed from.
CREATE OR REPLACE FUNCTION job_heartbeat_monotonic() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_success_at IS NOT NULL AND OLD.last_success_at IS NOT NULL
     AND NEW.last_success_at < OLD.last_success_at THEN
    NEW.last_success_at := OLD.last_success_at;
  END IF;
  IF NEW.last_run_at IS NOT NULL AND OLD.last_run_at IS NOT NULL
     AND NEW.last_run_at < OLD.last_run_at THEN
    NEW.last_run_at := OLD.last_run_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS job_heartbeat_monotonic ON job_heartbeats;
CREATE TRIGGER job_heartbeat_monotonic
  BEFORE UPDATE ON job_heartbeats
  FOR EACH ROW EXECUTE FUNCTION job_heartbeat_monotonic();

-- The recent history the console shows when an operator asks "why is this
-- amber". Bounded by the retention job rather than kept forever: the timer job
-- alone writes 8,640 rows a day and none of them is interesting after a week.
CREATE TABLE IF NOT EXISTS job_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name     text NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  ok           boolean NOT NULL,
  duration_ms  integer NOT NULL,
  error        text
);

-- Only failures are retained long; successes are a heartbeat, not evidence.
CREATE INDEX IF NOT EXISTS job_runs_recent ON job_runs (job_name, finished_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_failures ON job_runs (finished_at DESC) WHERE ok = false;

GRANT SELECT, INSERT, UPDATE ON job_heartbeats TO adw_app;
GRANT SELECT, INSERT, DELETE ON job_runs TO adw_app;
