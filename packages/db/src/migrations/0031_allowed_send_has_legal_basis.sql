-- An allowed send must record what allowed it.
--
-- `gate_decisions` is the seven-year evidence record for every message this
-- system sends, and it is append-only precisely because it is evidence. An
-- `allow = true` row with `legal_basis` NULL says a message went out and
-- nothing at all about why we were entitled to send it. If a recipient or a
-- regulator asks, the honest answer is that we do not know — which is the same
-- answer as having no record at all, arrived at more expensively.
--
-- The gate itself has always written the triple on an allow. What made this
-- possible was the schema permitting rows the gate would never produce, and
-- four test fixtures inserting exactly those — so the shape existed, was
-- reachable, and nothing said it was wrong.
--
-- ⛔ NOT VALID, DELIBERATELY. 192 historical rows are missing the basis and
-- they are immutable evidence: `adw_app` holds INSERT and SELECT only, and a
-- trigger enforces append-only. Backfilling them would mean writing a legal
-- basis nobody determined into a compliance record — manufacturing the exact
-- evidence this constraint exists to guarantee, which is worse than the gap.
-- NOT VALID binds every future row and leaves the record as it actually is.
--
-- Written so it bites: `allow` is NOT NULL and `IS NOT NULL` never yields NULL,
-- so this is always TRUE or FALSE and never the NULL that a CHECK would accept.
-- (The first version of the qa_packs approval constraint in 0028 was exactly
-- that mistake, and enforced nothing.)
ALTER TABLE gate_decisions DROP CONSTRAINT IF EXISTS gate_decisions_allow_has_basis_ck;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_allow_has_basis_ck CHECK (
  NOT allow
  OR (legal_basis IS NOT NULL AND jurisdiction IS NOT NULL AND obligations IS NOT NULL)
) NOT VALID;
