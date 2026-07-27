-- The workflow outbox.
--
-- The API and the worker are separate processes: the API takes the request, the
-- worker owns the engine. Until now the API recorded what happened (a preview
-- was claimed, a revision was asked for) and nothing turned that into a workflow
-- start or a signal — every entry point into the pipeline was a dead end.
--
-- The API could call the engine directly, but then a crash between "row written"
-- and "workflow started" loses the work silently, and two processes end up
-- driving the same executions. So: the API writes an intent in the same
-- transaction as its own state change, and a worker job drains it. At-least-once
-- delivery, which is safe because start() is ON CONFLICT DO NOTHING and signals
-- are deduped by the workflow's own logic.

CREATE TABLE IF NOT EXISTS workflow_intents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'start' creates an execution; 'signal' delivers to an existing one.
  kind           TEXT NOT NULL CHECK (kind IN ('start', 'signal')),
  workflow_type  TEXT NOT NULL,
  execution_id   TEXT NOT NULL,
  -- Signal name for kind='signal'; NULL for a start.
  signal_name    TEXT,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  attempts       SMALLINT NOT NULL DEFAULT 0,
  last_error     TEXT,
  CHECK (kind = 'start' OR signal_name IS NOT NULL)
);

-- The dispatcher's only query: unprocessed, oldest first, bounded retries.
CREATE INDEX IF NOT EXISTS workflow_intents_pending
  ON workflow_intents (created_at)
  WHERE processed_at IS NULL;

-- One start per execution id. A double-submitted claim must not enqueue two
-- onboardings; the unique index makes that a no-op at write time rather than
-- something the dispatcher has to reason about.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_intents_one_start
  ON workflow_intents (execution_id)
  WHERE kind = 'start';

GRANT SELECT, INSERT, UPDATE ON workflow_intents TO adw_app;
