-- Publishing (catalogue MF12 — 12 units) and content drafting (MF13 — 13).
--
-- The system could build a site. It could not say anything afterwards: no post,
-- no listing update, no offer, no article, not even a ping to tell a search
-- engine the site had changed.
--
-- ⛔ One table, and the state machine in it is the safety property:
--        draft → approved → published
--                    ↓
--                 rejected
-- Nothing reaches a connector from `draft`. An owner approving is the only
-- transition into `approved`, and `approved` is the only state a publisher
-- reads. A system that posts unattended to a business's Google profile can say
-- something wrong in their name, in public, and the correction never travels as
-- far as the mistake.

CREATE TABLE IF NOT EXISTS publications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id),
  channel       TEXT NOT NULL,             -- config/channels.yaml id
  channel_version TEXT NOT NULL,
  topic         TEXT NOT NULL,
  -- Prose channels use `body`; data channels (a feed, a directory record, an ad
  -- audience) use `payload`. Both are present so one publisher covers both.
  body          TEXT NOT NULL DEFAULT '',
  payload       JSONB NOT NULL DEFAULT '{}',
  -- ⛔ Which KB facts the draft was built from. A marketing claim with no
  -- traceable source is the thing the whole grounding apparatus exists to stop,
  -- and after publication this is the only record of what it rested on.
  source_facts  TEXT[] NOT NULL DEFAULT '{}',
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','rejected','published','failed')),
  drafted_by    TEXT NOT NULL DEFAULT 'system',
  drafted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  -- TRUE when the owner changed the words before approving. Worth knowing: a
  -- channel whose drafts are always edited is a prompt that needs work.
  edited        BOOLEAN NOT NULL DEFAULT FALSE,
  rejected_reason TEXT,
  published_at  TIMESTAMPTZ,
  external_id   TEXT,
  -- ⛔ Sent to the connector so a retry after a timeout is the same post rather
  -- than a second one. A duplicate on a business's own profile is visible to
  -- their customers and cannot be recalled.
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts      SMALLINT NOT NULL DEFAULT 0,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS publications_queue
  ON publications (state, approved_at) WHERE state = 'approved';
CREATE INDEX IF NOT EXISTS publications_customer
  ON publications (customer_id, channel, published_at DESC);

-- ⛔ What went out is what was approved. Without this, an edit between approval
-- and publication — or after it — would leave the audit trail asserting a
-- sign-off against words the owner never read.
CREATE OR REPLACE FUNCTION publication_body_is_final() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state IN ('approved','published','rejected')
     AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.payload IS DISTINCT FROM OLD.payload)
  THEN
    RAISE EXCEPTION 'publication % is % — its content cannot be changed', OLD.id, OLD.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS publications_body_final ON publications;
CREATE TRIGGER publications_body_final
  BEFORE UPDATE ON publications
  FOR EACH ROW EXECUTE FUNCTION publication_body_is_final();
