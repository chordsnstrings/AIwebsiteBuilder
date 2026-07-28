-- v3.0 — the product changed.
--
-- v1 sold websites. The market was measured (3,559 businesses, 8 countries) and
-- that thesis failed: 92–98% already have a site and 1.2% fail on mobile. What
-- almost nobody has is a machine-readable, bookable business — 9.6% publish
-- Service schema, 24.7% publish a price, 11.6% clear both. The product is now
-- the transaction layer: a knowledge base extracted from what a business has
-- published, a Q&A pack the owner approves, and an agent that answers only from
-- that pack and refuses outside it.
--
-- Everything this migration adds exists to make that grounded rather than
-- asserted. A fact carries its source URL. A Q&A pair carries the fact ids it
-- came from. A pair with no source cannot be written.

-- ---------------------------------------------------------------------------
-- Transactability grading (workflow A2) — the audit the pitch is built from
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_audits (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id),
  has_website         BOOLEAN NOT NULL,
  reachable           BOOLEAN NOT NULL DEFAULT TRUE,
  https               BOOLEAN NOT NULL DEFAULT FALSE,
  viewport_meta       BOOLEAN NOT NULL DEFAULT FALSE,
  lighthouse          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  schema_types        TEXT[]  NOT NULL DEFAULT '{}',
  has_service_schema  BOOLEAN NOT NULL DEFAULT FALSE,
  pricing_found       BOOLEAN NOT NULL DEFAULT FALSE,
  booking_found       BOOLEAN NOT NULL DEFAULT FALSE,
  booking_provider    TEXT,
  llms_txt            BOOLEAN NOT NULL DEFAULT FALSE,
  page_count          INT     NOT NULL DEFAULT 0,
  word_count          INT     NOT NULL DEFAULT 0,
  platform            TEXT,
  -- TRUE when the business is NOT machine-readable-and-bookable. This is the
  -- gap we sell against; FALSE means they are already in the 11.6% and should
  -- be scored down hard, not pitched.
  transactability_gap BOOLEAN NOT NULL DEFAULT TRUE,
  -- Every entry MUST trace to a deterministic check. The model phrases; it
  -- never asserts (§19.4) — an untrue claim in outreach is how the channel dies.
  top_defects         JSONB   NOT NULL DEFAULT '[]'::jsonb,
  audited_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_audits_business ON site_audits (business_id, audited_at DESC);

-- ---------------------------------------------------------------------------
-- Delivery manifest (workflow A3) — what this business actually gets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_manifests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID NOT NULL REFERENCES businesses(id),
  customer_id        UUID REFERENCES customers(id),
  vertical           TEXT NOT NULL,
  confidence         NUMERIC(4,3) NOT NULL,
  modifiers          TEXT[] NOT NULL DEFAULT '{}',
  site_modules       JSONB NOT NULL DEFAULT '[]'::jsonb,
  agent_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  integrations       JSONB NOT NULL DEFAULT '[]'::jsonb,
  dashboard_panels   JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- What was deliberately left out, and why. A manifest that only lists what
  -- is included cannot be reviewed.
  excluded           JSONB NOT NULL DEFAULT '[]'::jsonb,
  unresolved         JSONB NOT NULL DEFAULT '[]'::jsonb,
  playbook_version   TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_manifests_business ON delivery_manifests (business_id, created_at DESC);

-- A manifest is immutable for the build that used it (§20.1): a change is a new
-- manifest and a new build, never an edit to the record a build was reviewed on.
CREATE OR REPLACE FUNCTION adw_manifest_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'delivery_manifests is immutable — issue a new manifest instead';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS delivery_manifests_no_update ON delivery_manifests;
CREATE TRIGGER delivery_manifests_no_update
  BEFORE UPDATE OR DELETE ON delivery_manifests
  FOR EACH ROW EXECUTE FUNCTION adw_manifest_immutable();

-- ---------------------------------------------------------------------------
-- Knowledge base (workflow A4) — only what they published
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_bases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID NOT NULL REFERENCES businesses(id),
  customer_id  UUID REFERENCES customers(id),
  version      INT  NOT NULL DEFAULT 1,
  site_hash    TEXT,
  gbp_hash     TEXT,
  -- Fewer than 5 pages / 400 words: the pack falls back to the vertical
  -- template and onboarding asks more questions.
  thin         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, version)
);

CREATE TABLE IF NOT EXISTS kb_facts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id        UUID NOT NULL REFERENCES knowledge_bases(id),
  fact_key     TEXT NOT NULL,          -- 'hours' | 'service' | 'price' | 'area' | …
  type         TEXT NOT NULL,
  value        TEXT NOT NULL,
  -- Provenance per fact is what makes grounding defensible rather than
  -- asserted. Both columns are NOT NULL on purpose.
  source_url   TEXT NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL,
  confidence   NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  -- 'claimed_unverified' is the important one: a certification on their site we
  -- could not verify. The agent may NEVER assert it (§21.2).
  status       TEXT NOT NULL DEFAULT 'verified'
               CHECK (status IN ('verified','claimed_unverified','stale','inferred')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_facts_kb ON kb_facts (kb_id);

-- Conflicts are FLAGGED, never resolved. Site says 9–5, GBP says 8–6: that is a
-- question for the owner, not a coin flip for a model.
CREATE TABLE IF NOT EXISTS kb_conflicts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id       UUID NOT NULL REFERENCES knowledge_bases(id),
  fact_ids    UUID[] NOT NULL,
  description TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_value TEXT
);

-- ---------------------------------------------------------------------------
-- Q&A pack (workflow A5) — what the agent retrieves from at runtime
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_packs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id              UUID NOT NULL REFERENCES knowledge_bases(id),
  business_id        UUID NOT NULL REFERENCES businesses(id),
  customer_id        UUID REFERENCES customers(id),
  version            INT NOT NULL DEFAULT 1,
  pair_count         INT NOT NULL DEFAULT 0,
  coverage           JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_fallbacks JSONB NOT NULL DEFAULT '[]'::jsonb,
  thin               BOOLEAN NOT NULL DEFAULT FALSE,
  -- The owner approves the pack before go-live. That approval is what makes a
  -- stored answer defensible: they published it, and they signed it off.
  approved_at        TIMESTAMPTZ,
  approved_by        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, version)
);

CREATE TABLE IF NOT EXISTS qa_pairs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id         UUID NOT NULL REFERENCES qa_packs(id),
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  -- MUST be non-empty for a generated pair: an answer with no source fact is
  -- exactly the failure this architecture exists to prevent. Template refusal
  -- pairs are the one permitted exception and are marked as such below.
  source_fact_ids UUID[] NOT NULL DEFAULT '{}',
  -- float32 little-endian; see packages/qapack/src/embedding.ts. Stored as
  -- bytea rather than a vector type because pgvector is not guaranteed
  -- present — the retrieval interface is identical either way and a pack is
  -- 150–250 pairs, which brute-force scans exactly and in microseconds.
  embedding       BYTEA,
  embedding_dims  SMALLINT,
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  source          TEXT NOT NULL DEFAULT 'generated'
                  CHECK (source IN ('generated','template_refusal','promoted_fallback')),
  approved_at     TIMESTAMPTZ,
  approved_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source <> 'generated' OR array_length(source_fact_ids, 1) >= 1)
);
CREATE INDEX IF NOT EXISTS qa_pairs_pack ON qa_pairs (pack_id);

-- ---------------------------------------------------------------------------
-- The customer's agent at runtime (pipeline D)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  business_id UUID REFERENCES businesses(id),
  preview_id  UUID REFERENCES previews(id),
  channel     TEXT NOT NULL DEFAULT 'web',   -- 'web'|'whatsapp'|'mcp'|'voice'
  visitor_ref TEXT,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  CHECK (customer_id IS NOT NULL OR preview_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS agent_sessions_customer ON agent_sessions (customer_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS agent_turns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES agent_sessions(id),
  turn_index      INT NOT NULL,
  inbound         TEXT NOT NULL,
  intent          TEXT,
  route           TEXT NOT NULL,   -- 'retrieval'|'booking'|'lead_capture'|'fallback'|'escalate'|'photo'
  -- The fused RRF score of the winning pair, or NULL on a miss. This column is
  -- how the retrieval hit rate is measured, and the hit rate drives both cost
  -- and how grounded the product actually is.
  retrieval_score NUMERIC(5,4),
  pair_id         UUID REFERENCES qa_pairs(id),
  answered_from   TEXT NOT NULL,   -- 'pack'|'pack_hedged'|'fallback'|'refusal'|'state_machine'
  answer          TEXT,
  latency_ms      INT,
  cost_cents      NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS agent_turns_session ON agent_turns (session_id, turn_index);
CREATE INDEX IF NOT EXISTS agent_turns_route ON agent_turns (route, created_at DESC);

-- A retrieval miss is a gap in the business's own published content. This table
-- is the dashboard's most useful panel and the self-improving loop's input.
CREATE TABLE IF NOT EXISTS agent_gaps (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID REFERENCES customers(id),
  business_id      UUID REFERENCES businesses(id),
  question         TEXT NOT NULL,
  question_norm    TEXT NOT NULL,
  times_asked      INT NOT NULL DEFAULT 1,
  first_asked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_asked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  drafted_answer   TEXT,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','drafted','approved','dismissed')),
  -- Set only when the OWNER approved the draft. An auto-promoted answer is a
  -- system learning its own hallucinations (§21.5).
  approved_at      TIMESTAMPTZ,
  approved_by      TEXT,
  promoted_pair_id UUID REFERENCES qa_pairs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_gaps_dedupe
  ON agent_gaps (COALESCE(customer_id, business_id), question_norm);

-- ---------------------------------------------------------------------------
-- Deterministic state machines — not conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enquiries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id),
  business_id UUID REFERENCES businesses(id),
  session_id  UUID REFERENCES agent_sessions(id),
  name        TEXT,
  need        TEXT,
  contact     TEXT,
  urgency     TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('emergency','urgent','normal')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','contacted','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiries_customer ON enquiries (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bookings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID REFERENCES customers(id),
  session_id        UUID REFERENCES agent_sessions(id),
  slot_start        TIMESTAMPTZ NOT NULL,
  slot_end          TIMESTAMPTZ NOT NULL,
  contact           TEXT,
  calendar_event_id TEXT,
  status            TEXT NOT NULL DEFAULT 'held'
                    CHECK (status IN ('held','confirmed','cancelled')),
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photo_assessments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID REFERENCES customers(id),
  session_id     UUID REFERENCES agent_sessions(id),
  image_r2_key   TEXT NOT NULL,
  assessment     JSONB NOT NULL,
  -- What the photo does NOT show. Stating this is the difference between an
  -- assessment and a guess.
  not_determinable TEXT[] NOT NULL DEFAULT '{}',
  urgent         BOOLEAN NOT NULL DEFAULT FALSE,
  -- Deliberately nullable and never written by the agent. The owner prices.
  price_cents    INT,
  owner_replied_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_assessments_queue
  ON photo_assessments (customer_id, created_at DESC) WHERE owner_replied_at IS NULL;

-- ---------------------------------------------------------------------------
-- The agent eval gate (workflow B7) — 30 cases, no partial credit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_eval_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id),
  pack_id      UUID NOT NULL REFERENCES qa_packs(id),
  total        INT NOT NULL,
  passed       INT NOT NULL,
  cases        JSONB NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  -- Set when booking cases were skipped because no calendar is connected; the
  -- agent ships with booking disabled and the run is re-run on connect.
  booking_skipped BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_eval_runs_customer ON agent_eval_runs (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_calendars (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id),
  provider     TEXT NOT NULL,      -- 'google'|'microsoft'
  external_ref TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  UNIQUE (customer_id, provider)
);

-- ---------------------------------------------------------------------------
-- DNS cutover (workflow B9) — the one that could end the company
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dns_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  domain      TEXT NOT NULL,
  -- A, AAAA, CNAME, MX, TXT, SRV, NS — complete, or the diff proves nothing.
  records     JSONB NOT NULL,
  provider    TEXT,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dns_snapshots_customer ON dns_snapshots (customer_id, taken_at DESC);

-- Snapshots are evidence. Without a trustworthy before-state the safety claim
-- is a promise rather than a verified assertion.
DROP TRIGGER IF EXISTS dns_snapshots_append_only ON dns_snapshots;
CREATE TRIGGER dns_snapshots_append_only
  BEFORE UPDATE OR DELETE ON dns_snapshots
  FOR EACH ROW EXECUTE FUNCTION adw_manifest_immutable();

CREATE TABLE IF NOT EXISTS dns_cutovers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          UUID NOT NULL REFERENCES customers(id),
  domain               TEXT NOT NULL,
  snapshot_id          UUID NOT NULL REFERENCES dns_snapshots(id),
  applied              JSONB NOT NULL DEFAULT '[]'::jsonb,   -- the two records
  diff                 JSONB,
  -- Target zero, alert at one. Also a Sentinel probe.
  mail_records_changed BOOLEAN NOT NULL DEFAULT FALSE,
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','applied','verified','reverted','halted')),
  customer_approved_at TIMESTAMPTZ,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Links from existing tables into the new product
-- ---------------------------------------------------------------------------
ALTER TABLE builds     ADD COLUMN IF NOT EXISTS manifest_id UUID REFERENCES delivery_manifests(id);
ALTER TABLE builds     ADD COLUMN IF NOT EXISTS pack_id     UUID REFERENCES qa_packs(id);
ALTER TABLE previews   ADD COLUMN IF NOT EXISTS pack_id     UUID REFERENCES qa_packs(id);
ALTER TABLE previews   ADD COLUMN IF NOT EXISTS manifest_id UUID REFERENCES delivery_manifests(id);
ALTER TABLE customers  ADD COLUMN IF NOT EXISTS vertical    TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS vertical    TEXT;

GRANT SELECT, INSERT, UPDATE ON site_audits, delivery_manifests, knowledge_bases, kb_facts,
  kb_conflicts, qa_packs, qa_pairs, agent_sessions, agent_turns, agent_gaps, enquiries,
  bookings, photo_assessments, agent_eval_runs, customer_calendars, dns_snapshots,
  dns_cutovers TO adw_app;

-- The app may read and write evidence, never remove it.
REVOKE DELETE ON delivery_manifests, dns_snapshots, kb_facts FROM adw_app;
