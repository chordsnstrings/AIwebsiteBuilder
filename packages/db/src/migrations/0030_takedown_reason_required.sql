-- A takedown must say why.
--
-- ⛔ Taking a preview down is a compliance action with a clock on it — the spec
-- gives it one hour — and it happens for reasons that are not
-- interchangeable: the business asked us to stop ("This isn't for me"), or the
-- 30-day window simply ran out. Those produce different obligations. The first
-- is a signal that must reach suppression and must be answerable if the ICO or
-- the business itself asks what we did and when; the second is housekeeping.
--
-- `takedown_reason` was nullable and 64 rows had a timestamp with no reason
-- beside it, which is a record that the page came down and nothing at all about
-- whether anybody asked. Both production writers already set one, so this makes
-- the schema agree with the code rather than changing any behaviour — and it
-- makes the fixture that produced those 64 rows impossible.
--
-- ⛔ The existing rows are backfilled to 'unrecorded', not to a guess. Writing
-- 'expired' over them would manufacture the very attribution this constraint
-- exists to guarantee, and 'unrecorded' is the true statement: these predate
-- the requirement and nobody can now say which they were.
UPDATE previews SET takedown_reason = 'unrecorded'
 WHERE takedown_at IS NOT NULL AND takedown_reason IS NULL;

-- Written so it bites: with `takedown_at` set and the reason NULL this is
-- `FALSE OR FALSE`, not NULL. (A CHECK accepts NULL, which is how the first
-- version of the qa_packs approval constraint in 0028 enforced nothing.)
ALTER TABLE previews DROP CONSTRAINT IF EXISTS previews_takedown_has_reason_ck;
ALTER TABLE previews ADD CONSTRAINT previews_takedown_has_reason_ck CHECK (
  takedown_at IS NULL OR takedown_reason IS NOT NULL
);
