-- Protocol incidents (catalogue MF14).
--
-- ⛔ Append-only evidence. When someone discloses a safeguarding concern or
-- reports a gas smell, the record of what they said and when we told a human is
-- the thing that gets read out in an inquiry. It is not editable, and the
-- trigger below is what makes that true rather than the convention.
--
-- The clock is the product. `acknowledged_at` starts null and STAYS null until
-- a named human presses a button; every escalation step fires off that.

CREATE TABLE IF NOT EXISTS protocol_incidents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_id     TEXT NOT NULL,             -- config/protocols.yaml id
  protocol_version TEXT NOT NULL,            -- content hash of the catalogue that fired
  severity        SMALLINT NOT NULL,
  customer_id     UUID REFERENCES customers(id),
  business_id     UUID REFERENCES businesses(id),
  session_id      UUID,                      -- agent_sessions, when it came from a chat
  channel         TEXT NOT NULL DEFAULT 'web',
  -- ⛔ VERBATIM. Several of these protocols say "capture verbatim" because a
  -- paraphrase of a disclosure is not evidence of the disclosure. Never
  -- summarised, never tidied, never passed through a model.
  trigger_text    TEXT NOT NULL,
  matched_on      TEXT NOT NULL,             -- the exact substring that fired
  interlocks      TEXT[] NOT NULL DEFAULT '{}',
  -- What the agent said back, stored so a review can see the visitor's whole
  -- experience rather than only our side of it.
  agent_response  TEXT NOT NULL,
  detected_by     TEXT NOT NULL,             -- 'automatic' | 'manual'
  raised_by       TEXT,                      -- operator email when manual
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  resolved_at     TIMESTAMPTZ,
  resolution      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS protocol_incidents_open
  ON protocol_incidents (acknowledged_at, severity, created_at)
  WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS protocol_incidents_customer ON protocol_incidents (customer_id, created_at DESC);

-- Every notification attempt, in order. A step that fired and a step that is due
-- are different rows, so "we tried to reach you at 03:12" is answerable.
CREATE TABLE IF NOT EXISTS protocol_escalations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   UUID NOT NULL REFERENCES protocol_incidents(id),
  step_index    SMALLINT NOT NULL,
  notify_role   TEXT NOT NULL,
  due_at        TIMESTAMPTZ NOT NULL,
  fired_at      TIMESTAMPTZ,
  delivered     BOOLEAN,
  detail        TEXT,
  UNIQUE (incident_id, step_index)
);
CREATE INDEX IF NOT EXISTS protocol_escalations_due
  ON protocol_escalations (due_at) WHERE fired_at IS NULL;

-- ⛔ Append-only, like provenance and gate_decisions. An incident record that
-- can be edited after the fact is not evidence of anything.
CREATE OR REPLACE FUNCTION protocol_incidents_no_rewrite() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'protocol_incidents is append-only: a deleted incident is a destroyed record';
  END IF;
  -- Acknowledgement and resolution are the ONLY mutable fields, and neither can
  -- be un-set: you cannot un-acknowledge an incident to restart its clock.
  IF NEW.trigger_text IS DISTINCT FROM OLD.trigger_text
     OR NEW.protocol_id IS DISTINCT FROM OLD.protocol_id
     OR NEW.matched_on IS DISTINCT FROM OLD.matched_on
     OR NEW.agent_response IS DISTINCT FROM OLD.agent_response
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'protocol_incidents evidence fields are immutable';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'an incident cannot be un-acknowledged';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protocol_incidents_append_only ON protocol_incidents;
CREATE TRIGGER protocol_incidents_append_only
  BEFORE UPDATE OR DELETE ON protocol_incidents
  FOR EACH ROW EXECUTE FUNCTION protocol_incidents_no_rewrite();
