-- Agent invocation cost was rounding every row to zero.
--
-- ⛔ `agent_invocations.cost_cents` was declared `integer` and the writer did
-- `Math.round(envelope.costCents)`. A model call in this system costs a
-- FRACTION of a cent — the measured average over 2,118 gateway completions is
-- 0.045 cents, and the cheapest agent's entire per-output budget is 0.2 cents.
-- So every value rounded to 0, and all 1,587 rows recorded zero cost.
--
-- The table was therefore reporting, with total confidence, that the agent
-- fleet had cost nothing. That is precisely the failure this whole console was
-- built to stop, committed in the ledger written to prevent it.
--
-- `events.cost_cents` is already numeric(12,6) for exactly this reason. Matching
-- it, so the two sources of model spend are in the same unit and comparable
-- rather than quietly disagreeing by a factor of a hundred.
ALTER TABLE agent_invocations
  ALTER COLUMN cost_cents TYPE numeric(12,6) USING cost_cents::numeric(12,6);

-- ⛔ The existing rows are all zero and cannot be recovered — the precision was
-- destroyed at write time, not at read time. They are left in place rather than
-- deleted (the table is append-only evidence) but nothing should read cost from
-- rows written before this migration. The console reports total spend from the
-- gateway's `events`, which never lost it.
COMMENT ON COLUMN agent_invocations.cost_cents IS
  'Fractional cents, numeric(12,6). Rows written before migration 0025 are all 0 because the column was integer; do not read cost from them.';
