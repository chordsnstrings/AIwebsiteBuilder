-- Every agent invocation, with the envelope the agent actually returned.
--
-- ⛔ WHAT THIS FIXES. `defineAgent` computes five things on every single run —
-- confidence, injectionSuspected, escalate, escalateReason and firstPass — and
-- returned all five to the caller while writing NONE of them. Ten call sites
-- take that envelope; not one persists it.
--
-- The consequences, in order of seriousness:
--
--   1. Every prompt-injection detection this system makes is discarded. An
--      agent notices "ignore previous instructions" in a listing, sets the
--      flag, and the flag dies in a local variable. There is no record that it
--      ever happened, no count, and nothing for a canary or a human to read.
--      The spec requires per-role canaries that halt a role; a canary needs a
--      population to fire against, and there was none.
--   2. First-pass rate is a stated success monitor (M2 >= 92%) and could not be
--      computed per agent, because the flag was never stored.
--   3. Escalations were computed and dropped, so "which agent escalates most,
--      and why" was unanswerable.
--
-- The gateway records the MODEL call — role, model, cost, tokens — in `events`.
-- This table records the AGENT call, which is a different event one layer up:
-- the same model call can be a first pass or an escalation retry, injection-
-- suspected or clean, and the gateway cannot see any of that.
CREATE TABLE IF NOT EXISTS agent_invocations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The agent, not just the model role: two agents can share a role.
  agent_id           text NOT NULL,
  role               text NOT NULL,
  model              text NOT NULL,
  data_class         text NOT NULL,
  -- What it was about, when the caller knew. Free-form because subjects span
  -- businesses, customers, leads, sessions and builds.
  subject_id         text,
  trace_id           text,
  -- Fractional cents. A model call here costs well under one cent, so an
  -- integer column rounds every row to zero (see migration 0025).
  cost_cents         numeric(12,6) NOT NULL DEFAULT 0,
  -- ⛔ The success monitor. False means the escalation ladder was used, which
  -- costs more and means the champion did not produce a valid output first try.
  first_pass         boolean NOT NULL,
  confidence         numeric(4,3),
  -- ⛔ A security signal, and the reason this table is append-only.
  injection_suspected boolean NOT NULL DEFAULT false,
  escalated          boolean NOT NULL DEFAULT false,
  escalate_reason    text,
  duration_ms        integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ⛔ Append-only. An injection detection or an escalation is evidence: if it can
-- be edited or deleted it is not evidence, and the one thing an attacker who
-- got a prompt through would most want is for the flag to go away.
CREATE OR REPLACE FUNCTION agent_invocation_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_invocations is append-only: an invocation record is evidence';
END $$;

DROP TRIGGER IF EXISTS agent_invocation_no_update ON agent_invocations;
CREATE TRIGGER agent_invocation_no_update
  BEFORE UPDATE OR DELETE ON agent_invocations
  FOR EACH ROW EXECUTE FUNCTION agent_invocation_is_final();

-- The console's main read: one agent's recent history, newest first.
CREATE INDEX IF NOT EXISTS agent_invocations_by_role ON agent_invocations (role, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_invocations_by_agent ON agent_invocations (agent_id, created_at DESC);
-- Partial indexes, because these are the rare rows and the ones always wanted.
CREATE INDEX IF NOT EXISTS agent_invocations_injection
  ON agent_invocations (created_at DESC) WHERE injection_suspected = true;
CREATE INDEX IF NOT EXISTS agent_invocations_escalated
  ON agent_invocations (created_at DESC) WHERE escalated = true;
CREATE INDEX IF NOT EXISTS agent_invocations_retried
  ON agent_invocations (role, created_at DESC) WHERE first_pass = false;
CREATE INDEX IF NOT EXISTS agent_invocations_subject ON agent_invocations (subject_id) WHERE subject_id IS NOT NULL;

-- ⛔ INSERT and SELECT only. No UPDATE, no DELETE grant, matching suppression
-- and gate_decisions: the trigger states the intent and the grant enforces it
-- even against a superuser mistake in a migration.
GRANT SELECT, INSERT ON agent_invocations TO adw_app;
