-- Security invariants enforced at the database layer (spec §43, §14.2.5).
-- These survive a misconfigured application role — belt and suspenders.

-- ---------------------------------------------------------------------------
-- Append-only tables: no UPDATE, no DELETE, ever (suppression, provenance,
-- gate_decisions, vault_access_log, events, registry_audit).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION adw_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only; % is forbidden (spec §43)',
    TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER suppression_append_only
  BEFORE UPDATE OR DELETE ON suppression
  FOR EACH ROW EXECUTE FUNCTION adw_reject_mutation();

CREATE TRIGGER provenance_append_only
  BEFORE UPDATE OR DELETE ON provenance
  FOR EACH ROW EXECUTE FUNCTION adw_reject_mutation();

CREATE TRIGGER gate_decisions_append_only
  BEFORE UPDATE OR DELETE ON gate_decisions
  FOR EACH ROW EXECUTE FUNCTION adw_reject_mutation();

CREATE TRIGGER vault_access_log_append_only
  BEFORE UPDATE OR DELETE ON vault_access_log
  FOR EACH ROW EXECUTE FUNCTION adw_reject_mutation();

CREATE TRIGGER registry_audit_append_only
  BEFORE UPDATE OR DELETE ON registry_audit
  FOR EACH ROW EXECUTE FUNCTION adw_reject_mutation();

-- ---------------------------------------------------------------------------
-- tos_acceptance single-writer: the column may only be written when the GUC
-- adw.tos_writer = 'webhook' is set, which happens only inside the one
-- SECURITY DEFINER function the acceptance webhook handler calls.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION adw_guard_tos_acceptance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tos_acceptance IS DISTINCT FROM OLD.tos_acceptance THEN
    IF current_setting('adw.tos_writer', true) IS DISTINCT FROM 'webhook' THEN
      RAISE EXCEPTION 'tos_acceptance is writable only by the acceptance webhook handler (spec §14.2.5)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER merchant_tos_guard
  BEFORE UPDATE ON merchant_accounts
  FOR EACH ROW EXECUTE FUNCTION adw_guard_tos_acceptance();

-- The one blessed path. Sets the GUC locally for the transaction, then writes.
CREATE OR REPLACE FUNCTION adw_accept_tos(p_account UUID, p_acceptance JSONB)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM set_config('adw.tos_writer', 'webhook', true);
  UPDATE merchant_accounts SET tos_acceptance = p_acceptance, updated_at = now()
    WHERE id = p_account;
END;
$$;

-- ---------------------------------------------------------------------------
-- charge_type invariant: any connected account must be 'direct' (spec §14.1).
-- ---------------------------------------------------------------------------
ALTER TABLE merchant_accounts
  ADD CONSTRAINT merchant_charge_type_direct CHECK (charge_type = 'direct');

-- ---------------------------------------------------------------------------
-- Least-privilege grants for the application role. The app role can never
-- DELETE the append-only ledgers even if a trigger were dropped.
-- Guarded so the migration still runs where adw_app does not exist (PGlite).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'adw_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO adw_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO adw_app;
    GRANT EXECUTE ON FUNCTION adw_accept_tos(UUID, JSONB) TO adw_app;

    -- Revoke destructive rights on the append-only ledgers.
    REVOKE UPDATE, DELETE ON suppression FROM adw_app;
    REVOKE UPDATE, DELETE ON provenance FROM adw_app;
    REVOKE UPDATE, DELETE ON gate_decisions FROM adw_app;
    REVOKE UPDATE, DELETE ON vault_access_log FROM adw_app;
    REVOKE UPDATE, DELETE ON registry_audit FROM adw_app;
    -- events is append-only for the app too (analytics reads elsewhere).
    REVOKE UPDATE, DELETE ON events FROM adw_app;

    -- Future tables default to the same baseline.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adw_app;
  END IF;
END $$;
