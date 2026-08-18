-- The constraints behind `qa_packs.approval_kind`, written so that they bite.
--
-- ⛔ THE FIRST ATTEMPT PASSED VACUOUSLY, which is the failure this codebase
-- keeps finding and which a migration is an unusually good place to hide. It
-- read:
--
--   CHECK ((approved_at IS NULL     AND approval_kind IS NULL)
--       OR (approved_at IS NOT NULL AND approval_kind IN ('owner','speculative')))
--
-- With `approved_at` set and `approval_kind` NULL, the second branch is
-- `TRUE AND NULL` → NULL, the first is FALSE, and the whole expression is NULL.
-- A CHECK constraint ACCEPTS NULL. So the one row it existed to reject — an
-- approval with no recorded authority — was the row it let through, and an
-- `UPDATE qa_packs SET approved_at = now()` sailed past it. The constraint
-- looked present in `pg_constraint` and enforced nothing.
--
-- `approval_kind IS NOT NULL AND approval_kind IN (...)` is FALSE rather than
-- NULL in that case, so the constraint now fails closed.
ALTER TABLE qa_packs DROP CONSTRAINT IF EXISTS qa_packs_approval_kind_ck;
ALTER TABLE qa_packs ADD CONSTRAINT qa_packs_approval_kind_ck CHECK (
  (approved_at IS NULL AND approval_kind IS NULL)
  OR (
    approved_at IS NOT NULL
    AND approval_kind IS NOT NULL
    AND approval_kind IN ('owner', 'speculative')
  )
);

-- ⛔ The one that matters. A pack attached to a customer may only ever be
-- approved by its owner, so nothing can promote a policy approval — made so a
-- speculative preview could answer the owner it was built for — into a paying
-- customer's live agent. `IS DISTINCT FROM` is NULL-safe, so this branch was
-- never subject to the bug above.
ALTER TABLE qa_packs DROP CONSTRAINT IF EXISTS qa_packs_speculative_has_no_customer_ck;
ALTER TABLE qa_packs ADD CONSTRAINT qa_packs_speculative_has_no_customer_ck CHECK (
  approval_kind IS DISTINCT FROM 'speculative' OR customer_id IS NULL
);
