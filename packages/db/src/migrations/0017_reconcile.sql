-- Reconciliation (catalogue MF8 — 32 units).
--
-- Two sets of records that ought to agree, and what to do about the ones that
-- do not. There was no such object anywhere: `refunds` and `subscriptions`
-- track ADW's own money, and no customer had a way to hold two lists side by
-- side and ask which lines have no partner.
--
-- ⛔ Nothing in this schema can post an adjustment. There is no amount column
-- anywhere that a process writes to make a difference go away — the difference
-- is the product. Every unit in this family proposes; a person disposes.

CREATE TABLE IF NOT EXISTS recon_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  recon_type    TEXT NOT NULL,             -- config/reconciliations.yaml id
  type_version  TEXT NOT NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open', 'matched', 'closed')),
  statutory     BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched_at    TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ,
  closed_by     TEXT,
  -- What the run concluded, frozen at close.
  summary       JSONB NOT NULL DEFAULT '{}',
  UNIQUE (customer_id, recon_type, period_start, period_end)
);

-- ⛔ A closed run is immutable. Re-running a period after somebody has signed
-- it off must create a NEW run, not silently rewrite the one they signed: the
-- signature is against a set of differences, and rewriting them under it makes
-- the sign-off meaningless.
CREATE OR REPLACE FUNCTION recon_run_closed_is_final() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state = 'closed' THEN
    RAISE EXCEPTION 'recon run % is closed and cannot be modified', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recon_runs_closed_final ON recon_runs;
CREATE TRIGGER recon_runs_closed_final
  BEFORE UPDATE ON recon_runs
  FOR EACH ROW EXECUTE FUNCTION recon_run_closed_is_final();

CREATE TABLE IF NOT EXISTS recon_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
  side          TEXT NOT NULL CHECK (side IN ('ours', 'theirs')),
  -- The line's identity in its own source file. Makes ingestion idempotent: the
  -- same statement uploaded twice does not double the balance.
  source_key    TEXT NOT NULL,
  reference     TEXT,
  -- ⛔ BIGINT minor units. Never a numeric, never a float. A reconciliation is
  -- the one place a floating-point penny is guaranteed to be noticed, and the
  -- one place it must not be introduced.
  amount_cents  BIGINT NOT NULL,
  occurred_on   DATE,
  description   TEXT,
  raw           JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, side, source_key)
);
CREATE INDEX IF NOT EXISTS recon_items_run ON recon_items (run_id, side);
CREATE INDEX IF NOT EXISTS recon_items_ref ON recon_items (run_id, side, reference);

CREATE TABLE IF NOT EXISTS recon_matches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES recon_runs(id) ON DELETE CASCADE,
  -- 'matched'      the two sides agree within tolerance
  -- 'mismatched'   they are clearly the same transaction, different amount
  -- 'ambiguous'    more than one equally good partner — deliberately NOT matched
  -- 'unmatched_ours' / 'unmatched_theirs'  no partner at all
  status        TEXT NOT NULL CHECK (status IN
                ('matched','mismatched','ambiguous','unmatched_ours','unmatched_theirs')),
  strategy      TEXT,                      -- which rule produced it
  ours_ids      UUID[] NOT NULL DEFAULT '{}',
  theirs_ids    UUID[] NOT NULL DEFAULT '{}',
  amount_ours   BIGINT NOT NULL DEFAULT 0,
  amount_theirs BIGINT NOT NULL DEFAULT 0,
  delta_cents   BIGINT NOT NULL DEFAULT 0,
  note          TEXT,
  -- ⛔ How a difference was DISPOSED of by a human. There is no code path that
  -- sets these; they exist so that "we looked at it and it was a bank fee" is
  -- recorded next to the difference rather than in someone's memory.
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,
  resolution    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recon_matches_run ON recon_matches (run_id, status);
CREATE INDEX IF NOT EXISTS recon_matches_open
  ON recon_matches (run_id) WHERE status <> 'matched' AND resolved_at IS NULL;
