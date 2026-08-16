-- Uploads, document requirements, and the packs assembled from them (MF6, MF9).
--
-- ⛔ This is the most sensitive data the system will ever hold. A KYC pack is a
-- passport scan. A safeguarding attachment is a photograph of a child. A claims
-- evidence pack is somebody's house on the worst day of their year. Everything
-- below is shaped by that: content-addressed keys nobody can enumerate, an
-- access log with no delete grant, a retention date on every row, and no column
-- anywhere that holds the bytes.

CREATE TABLE IF NOT EXISTS uploads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID REFERENCES customers(id),
  business_id    UUID REFERENCES businesses(id),
  session_id     UUID REFERENCES agent_sessions(id),
  -- Where the bytes are. ⛔ Content-addressed and unguessable: an object key
  -- that encodes a customer id and a filename is an enumeration attack against
  -- other people's passports.
  storage_key    TEXT NOT NULL UNIQUE,
  -- What the BYTES say it is, from magic-number sniffing. Never the extension:
  -- `invoice.pdf` is whatever its first eight bytes say it is.
  detected_mime  TEXT NOT NULL,
  declared_name  TEXT NOT NULL,
  byte_size      INT NOT NULL,
  sha256         TEXT NOT NULL,
  -- 'clean' | 'pending' | 'infected' | 'skipped'. ⛔ Nothing is served to
  -- anyone while this is 'pending'.
  scan_status    TEXT NOT NULL DEFAULT 'pending',
  scanned_at     TIMESTAMPTZ,
  kind           TEXT NOT NULL,             -- 'photo' | 'document'
  uploaded_by    TEXT,                      -- 'visitor' | 'owner' | operator email
  -- ⛔ Every upload has an expiry from the moment it lands. An identity document
  -- with no retention date is an identity document kept forever by accident.
  retain_until   TIMESTAMPTZ NOT NULL,
  -- ⛔ Marketing consent is SEPARATE from having the file, and null by default.
  -- The catalogue's Portfolio Curator says field photos "become CONSENTED
  -- before/after portfolio entries". A customer sending a photo of their leak
  -- so it can be fixed has not agreed to it appearing on a website, and the
  -- difference between those two is the whole of this column.
  marketing_consent_at TIMESTAMPTZ,
  marketing_consent_by TEXT,
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uploads_customer ON uploads (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS uploads_expiring ON uploads (retain_until) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS uploads_unscanned ON uploads (created_at) WHERE scan_status = 'pending';

-- ⛔ Append-only. Who looked at whose passport, and when, is the record that
-- answers a regulator. There is deliberately no DELETE grant and no update path.
CREATE TABLE IF NOT EXISTS upload_access_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id   UUID NOT NULL REFERENCES uploads(id),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,               -- 'download' | 'link_minted' | 'deleted'
  detail      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS upload_access_log_upload ON upload_access_log (upload_id, at DESC);

-- A requirement set in flight: "we need these six things from this person".
CREATE TABLE IF NOT EXISTS document_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id),
  subject_ref    TEXT NOT NULL,             -- who it is about: contact, case, booking
  pack_id        TEXT NOT NULL,             -- config/document-packs.yaml id
  pack_version   TEXT NOT NULL,
  vertical       TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open', -- 'open'|'complete'|'abandoned'
  -- Chase schedule. Nulled when complete; a chase on a finished pack is the
  -- fastest way to have the owner turn the whole feature off.
  next_chase_at  TIMESTAMPTZ,
  chase_count    SMALLINT NOT NULL DEFAULT 0,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_requests_open
  ON document_requests (next_chase_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS document_requests_customer ON document_requests (customer_id, created_at DESC);

-- One row per required item. The item is 'received' when an upload is attached;
-- ⛔ it is never 'valid' — see packages/documents for why that word is absent.
CREATE TABLE IF NOT EXISTS document_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES document_requests(id),
  item_key      TEXT NOT NULL,
  label         TEXT NOT NULL,
  mandatory     BOOLEAN NOT NULL DEFAULT TRUE,
  upload_id     UUID REFERENCES uploads(id),
  received_at   TIMESTAMPTZ,
  -- A date the DOCUMENT states, transcribed by a human or read off a form.
  -- Never inferred, and never used to decide anything on its own.
  expires_on    DATE,
  note          TEXT,
  UNIQUE (request_id, item_key)
);
CREATE INDEX IF NOT EXISTS document_items_outstanding
  ON document_items (request_id) WHERE received_at IS NULL;
