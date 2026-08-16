-- Generated assets (catalogue MF13 — the ModelArk half).
--
-- The drafting half of MF13 shipped with `publications`. This is the other
-- half: images and short video generated for a business's site and posts.
--
-- ⛔ Two properties make this table unlike every other one in the schema.
--
-- 1. A row moving from 'approved' to 'ready' SPENDS REAL MONEY, per asset, and
--    the spend is not recoverable. So the state machine is
--        requested → approved → generating → ready
--                 └→ rejected            └→ failed
--    and `generate` reads 'approved' only. An unapproved request cannot reach a
--    billable generator. `estimated_cost_cents` is stamped at request time and
--    shown to the owner BEFORE they approve, because "approve" means nothing if
--    the person pressing it does not know the number.
--
-- 2. Everything in here is AI-generated and must stay marked as such forever.
--    `provenance` has a CHECK with one permitted value. An AI render of a
--    finished roof placed in a roofer's "our work" gallery is a false statement
--    about work they did, and the only thing standing between the two is the
--    column being impossible to un-set.

CREATE TABLE IF NOT EXISTS generated_assets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id),
  kind           TEXT NOT NULL CHECK (kind IN ('image','video')),
  -- config/asset-kinds.yaml id: hero, service_illustration, social_image, ...
  purpose        TEXT NOT NULL,
  -- ⛔ Where it may be placed. A slot the renderer treats as evidence of work
  -- done ("gallery", "case_study") is never in this list — see the loader.
  slot           TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  model          TEXT NOT NULL,
  provider       TEXT NOT NULL,
  -- ⛔ One permitted value, by CHECK rather than by convention. There is no
  -- code path that writes anything else and no path that clears it.
  provenance     TEXT NOT NULL DEFAULT 'ai_generated'
                 CHECK (provenance = 'ai_generated'),
  state          TEXT NOT NULL DEFAULT 'requested'
                 CHECK (state IN ('requested','approved','generating','ready','failed','rejected')),
  estimated_cost_cents INT NOT NULL,
  actual_cost_cents    INT,
  requested_by   TEXT NOT NULL DEFAULT 'system',
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by    TEXT,
  approved_at    TIMESTAMPTZ,
  rejected_reason TEXT,
  generated_at   TIMESTAMPTZ,
  -- The stored object, not the provider's URL: those expire in hours and an
  -- asset referenced by an expired URL is a broken image on a live site.
  storage_key    TEXT,
  bytes          INT,
  mime           TEXT,
  provider_task_id TEXT,
  last_error     TEXT,
  attempts       SMALLINT NOT NULL DEFAULT 0,
  publication_id UUID REFERENCES publications(id),
  -- ⛔ Sent to the provider AND unique here. A retried generation after a
  -- network timeout must not be charged twice.
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS generated_assets_queue
  ON generated_assets (state, approved_at) WHERE state = 'approved';
CREATE INDEX IF NOT EXISTS generated_assets_customer
  ON generated_assets (customer_id, requested_at DESC);
-- The spend window query runs on every request; make it cheap.
CREATE INDEX IF NOT EXISTS generated_assets_spend
  ON generated_assets (customer_id, generated_at) WHERE state = 'ready';

-- ⛔ Neither the prompt nor the estimate may change after approval. Without
-- this, "the owner approved a £0.06 image" and "the owner approved a £1.20
-- video of something else" are the same row.
CREATE OR REPLACE FUNCTION generated_asset_is_final() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state <> 'requested'
     AND (NEW.prompt IS DISTINCT FROM OLD.prompt
          OR NEW.model IS DISTINCT FROM OLD.model
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.estimated_cost_cents IS DISTINCT FROM OLD.estimated_cost_cents)
  THEN
    RAISE EXCEPTION 'generated asset % is % — what was approved cannot be changed', OLD.id, OLD.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS generated_assets_final ON generated_assets;
CREATE TRIGGER generated_assets_final
  BEFORE UPDATE ON generated_assets
  FOR EACH ROW EXECUTE FUNCTION generated_asset_is_final();

-- The monthly ceiling, per customer, in integer minor units. A row exists only
-- where an owner has set one; the code applies a conservative default
-- otherwise, because "no row" must not mean "no limit".
CREATE TABLE IF NOT EXISTS asset_budgets (
  customer_id      UUID PRIMARY KEY REFERENCES customers(id),
  monthly_cap_cents INT NOT NULL CHECK (monthly_cap_cents >= 0),
  set_by           TEXT NOT NULL,
  set_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
