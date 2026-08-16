-- The enterprise acquisition track.
--
-- The whole funnel was SMB-shaped: ingest, grade, build a speculative preview,
-- cold-email the link, take $399 on a card, let them claim it. For 33 of the 60
-- clusters in the taxonomy that is not a mispriced version of the right motion,
-- it is the wrong motion — and the preview half of it is actively damaging.
--
-- An OPPORTUNITY is the enterprise analogue of a lead: a named account moving
-- through stages, each of which may be guarded by evidence that has to exist
-- before it can be entered.
--
-- ⛔ `leads` is not reused. A lead carries a contact, a campaign, a preview and
-- a claim token; an opportunity carries none of those and must not appear to.
-- Overloading the table would have made "this account has no preview" and "this
-- lead's preview failed" the same query.

CREATE TABLE IF NOT EXISTS opportunities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id),
  -- Denormalised so the refusals can be asserted without a join to a taxonomy
  -- lookup that lives in application code.
  segment        TEXT NOT NULL CHECK (segment IN ('smb_local','enterprise_global')),
  vertical       TEXT NOT NULL,
  stage          TEXT NOT NULL DEFAULT 'identified',
  -- The function we are selling into, not a person: "Group IT", "Patient
  -- Access", "Procurement".
  target_function TEXT,
  named_contact_role TEXT,
  -- ⛔ Evidence for the gates, one key per requirement. Deliberately a JSONB
  -- bag rather than forty columns: the gate definitions live in config and a
  -- schema that had to be migrated to add a required piece of evidence would
  -- be a schema nobody adds evidence to.
  evidence       JSONB NOT NULL DEFAULT '{}',
  -- Quoted, never banded. NULL until commercials.
  quote_amount_cents BIGINT,
  quote_currency TEXT,
  owner_email    TEXT,
  lost_reason    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  -- One live opportunity per account. Two teams working the same logo is how a
  -- procurement contact receives two different pitches in a fortnight.
  UNIQUE (business_id)
);
CREATE INDEX IF NOT EXISTS opportunities_stage ON opportunities (segment, stage, updated_at DESC);

-- Every stage change, with who made it and what evidence was present. An
-- enterprise deal is reconstructed months later by people who were not there.
CREATE TABLE IF NOT EXISTS opportunity_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  from_stage     TEXT,
  to_stage       TEXT NOT NULL,
  gate           TEXT,
  actor          TEXT NOT NULL,
  note           TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_events_recent ON opportunity_events (opportunity_id, at DESC);

-- ⛔ The business case is what an enterprise account receives INSTEAD of a
-- speculative preview. It is a document about their problem, not a copy of
-- their brand hosted on our domain — that distinction is the entire reason this
-- table exists rather than a `previews` row with a flag on it.
CREATE TABLE IF NOT EXISTS business_cases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  target_function TEXT NOT NULL,
  -- Every figure traces to a deterministic check, same rule as the SMB audit.
  findings       JSONB NOT NULL DEFAULT '[]',
  audit_id       UUID,
  body           TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'draft'
                 CHECK (state IN ('draft','approved','sent','rejected')),
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (opportunity_id, target_function)
);
